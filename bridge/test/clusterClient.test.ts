/**
 * Tests for clusterClient.ts
 *
 * Strategy:
 * - Inject a mock fetchImpl that returns Response-like objects
 * - Use vi.useFakeTimers() for heartbeat interval testing
 * - After advancing fake timers, flush microtasks with multiple await Promise.resolve()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createClusterClient } from '../src/clusterClient.js'
import type { ClusterClientOptions } from '../src/clusterClient.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object */
function makeResponse(body: unknown, status = 200): Response {
  const json = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(json),
  } as unknown as Response
}

/** Flush microtask queue — call a few times after advancing fake timers */
async function flushPromises(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
  }
}

const BASE_OPTS: Omit<ClusterClientOptions, 'fetchImpl'> = {
  serverUrl: 'http://server.example.com',
  clusterToken: 'cluster-tok-abc',
  machineId: 'machine-uuid-1234',
  machineName: 'test-machine',
  selfUrl: 'http://localhost:7860',
  sessionToken: 'session-tok-xyz',
  os: 'linux',
  hostname: 'myhost',
  heartbeatIntervalMs: 1000, // short for tests
  maxRegisterAttempts: 3,   // finite for tests
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('clusterClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // 1. start() POSTs to /cluster/register with correct body + auth header
  // -------------------------------------------------------------------------

  it('start() POSTs to /cluster/register with correct body and auth header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: true }))
    const client = createClusterClient({ ...BASE_OPTS, fetchImpl: fetchMock })

    await client.start()
    await client.close()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://server.example.com/cluster/register',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer cluster-tok-abc',
          'Content-Type': 'application/json',
        }),
      }),
    )

    // Verify body fields
    const callArgs = fetchMock.mock.calls[0]!
    const body = JSON.parse((callArgs[1] as RequestInit).body as string)
    expect(body).toMatchObject({
      machineId: 'machine-uuid-1234',
      name: 'test-machine',
      url: 'http://localhost:7860',
      sessionToken: 'session-tok-xyz',
      os: 'linux',
      hostname: 'myhost',
    })
  })

  // -------------------------------------------------------------------------
  // 2. start() retries on network error with backoff
  // -------------------------------------------------------------------------

  it('start() retries on network error with backoff', async () => {
    let attempt = 0
    const fetchMock = vi.fn().mockImplementation(() => {
      attempt++
      if (attempt < 3) {
        return Promise.reject(new Error('network failure'))
      }
      return Promise.resolve(makeResponse({ ok: true }))
    })

    const client = createClusterClient({ ...BASE_OPTS, fetchImpl: fetchMock, maxRegisterAttempts: undefined })

    // start() kicks off but won't resolve until 3rd attempt — advance timers as needed
    const startPromise = client.start()

    // Flush for first attempt (fails immediately)
    await flushPromises()

    // Advance past backoff for attempt 2 (1s delay)
    vi.advanceTimersByTime(1100)
    await flushPromises()

    // Advance past backoff for attempt 3 (2s delay)
    vi.advanceTimersByTime(2100)
    await flushPromises()

    await startPromise
    await client.close()

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  // -------------------------------------------------------------------------
  // 3. start() retries on 500 response
  // -------------------------------------------------------------------------

  it('start() retries on 500 response', async () => {
    let attempt = 0
    const fetchMock = vi.fn().mockImplementation(() => {
      attempt++
      if (attempt < 2) {
        return Promise.resolve(makeResponse('Internal Server Error', 500))
      }
      return Promise.resolve(makeResponse({ ok: true }))
    })

    const client = createClusterClient({ ...BASE_OPTS, fetchImpl: fetchMock, maxRegisterAttempts: undefined })

    const startPromise = client.start()
    await flushPromises()

    vi.advanceTimersByTime(1100)
    await flushPromises()

    await startPromise
    await client.close()

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  // -------------------------------------------------------------------------
  // 4. start() throws if server returns { ok: false, error: ... }
  // -------------------------------------------------------------------------

  it('start() throws if server returns { ok: false, error: ... }', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ ok: false, error: 'duplicate machineId' }),
    )

    const client = createClusterClient({ ...BASE_OPTS, fetchImpl: fetchMock })

    await expect(client.start()).rejects.toThrow('duplicate machineId')
  })

  // -------------------------------------------------------------------------
  // 5. Heartbeat fires every heartbeatIntervalMs
  // -------------------------------------------------------------------------

  it('heartbeat fires every heartbeatIntervalMs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: true }))
    const client = createClusterClient({ ...BASE_OPTS, fetchImpl: fetchMock, heartbeatIntervalMs: 1000 })

    await client.start()
    // fetchMock was called once for register
    const registerCalls = fetchMock.mock.calls.length
    expect(registerCalls).toBe(1)

    // Advance 1 heartbeat interval
    vi.advanceTimersByTime(1000)
    await flushPromises()
    expect(fetchMock.mock.calls.length).toBe(2) // 1 register + 1 heartbeat

    // Advance 2 more intervals
    vi.advanceTimersByTime(2000)
    await flushPromises()
    expect(fetchMock.mock.calls.length).toBe(4) // 1 register + 3 heartbeats

    await client.close()
  })

  // -------------------------------------------------------------------------
  // 6. Heartbeat includes updated status from updateStatus()
  // -------------------------------------------------------------------------

  it('heartbeat includes updated status from updateStatus()', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: true }))
    const client = createClusterClient({ ...BASE_OPTS, fetchImpl: fetchMock })

    await client.start()

    client.updateStatus({
      status: 'running',
      sessionId: 'sess-abc',
      project: 'my-project',
    })

    // Trigger heartbeat
    vi.advanceTimersByTime(1000)
    await flushPromises()

    // Find the heartbeat call
    const heartbeatCall = fetchMock.mock.calls.find(
      (c) => (c[0] as string).includes('/cluster/heartbeat'),
    )
    expect(heartbeatCall).toBeDefined()

    const body = JSON.parse((heartbeatCall![1] as RequestInit).body as string)
    expect(body).toMatchObject({
      machineId: 'machine-uuid-1234',
      sessionToken: 'session-tok-xyz',
      status: 'running',
      sessionId: 'sess-abc',
      project: 'my-project',
    })

    await client.close()
  })

  // -------------------------------------------------------------------------
  // 7. 404 on heartbeat triggers re-registration
  // -------------------------------------------------------------------------

  it('404 "not registered" on heartbeat triggers re-register', async () => {
    let callCount = 0
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      callCount++
      if ((url as string).includes('/cluster/register')) {
        return Promise.resolve(makeResponse({ ok: true }))
      }
      // First heartbeat → 404, second → 200
      if ((url as string).includes('/cluster/heartbeat')) {
        if (callCount <= 2) { // call #2 is first heartbeat
          return Promise.resolve(makeResponse({ error: 'not registered' }, 404))
        }
        return Promise.resolve(makeResponse({ ok: true }))
      }
      return Promise.resolve(makeResponse({ ok: true }))
    })

    const client = createClusterClient({ ...BASE_OPTS, fetchImpl: fetchMock })
    await client.start()

    // Trigger first heartbeat (returns 404) → should trigger re-register
    vi.advanceTimersByTime(1000)
    await flushPromises(20)

    // Should have: 1 initial register + 1 heartbeat(404) + 1 re-register
    const registerCalls = fetchMock.mock.calls.filter(
      (c) => (c[0] as string).includes('/cluster/register'),
    )
    expect(registerCalls.length).toBeGreaterThanOrEqual(2)

    await client.close()
  })

  // -------------------------------------------------------------------------
  // 8. close() stops heartbeats
  // -------------------------------------------------------------------------

  it('close() stops heartbeats — no more fetch calls after close', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: true }))
    const client = createClusterClient({ ...BASE_OPTS, fetchImpl: fetchMock })

    await client.start()
    const callsAfterStart = fetchMock.mock.calls.length // 1 (register)

    // Fire one heartbeat
    vi.advanceTimersByTime(1000)
    await flushPromises()
    expect(fetchMock.mock.calls.length).toBe(callsAfterStart + 1)

    // Close stops the timer
    await client.close()
    const callsAfterClose = fetchMock.mock.calls.length

    // Advance past several intervals — no more calls expected
    vi.advanceTimersByTime(5000)
    await flushPromises()

    expect(fetchMock.mock.calls.length).toBe(callsAfterClose)
  })
})
