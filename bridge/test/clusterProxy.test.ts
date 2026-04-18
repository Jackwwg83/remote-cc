/**
 * Tests for clusterProxy.ts — server-side cross-machine proxy.
 *
 * Strategy:
 * - Use an injected fetchImpl mock to stand in for target bridges
 * - Use a minimal ClusterManager double that returns canned machine records
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createClusterProxy } from '../src/clusterProxy.js'
import type { ClusterManager, MachineState } from '../src/clusterManager.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMachine(overrides?: Partial<MachineState>): MachineState {
  return {
    machineId: 'machine-a',
    name: 'Alpha',
    url: 'http://alpha.local:7860',
    sessionToken: 'tok-alpha',
    status: 'idle',
    sessions: [],
    lastSeen: Date.now(),
    firstSeen: Date.now(),
    ...overrides,
  }
}

function makeCluster(machines: Record<string, MachineState>): ClusterManager {
  return {
    register: vi.fn(),
    heartbeat: vi.fn(),
    listMachines: () => Object.values(machines),
    getMachine: (id: string) => machines[id],
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as ClusterManager
}

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response
}

// ---------------------------------------------------------------------------
// forwardAction()
// ---------------------------------------------------------------------------

describe('clusterProxy.forwardAction()', () => {
  it('returns 404 when machine is unknown', async () => {
    const proxy = createClusterProxy({ cluster: makeCluster({}) })
    const result = await proxy.forwardAction({ machineId: 'nope', action: 'start_session' })
    expect(result.status).toBe(404)
    expect(result.body).toMatchObject({ error: expect.stringMatching(/not registered/) })
  })

  it('returns 404 when machine is offline', async () => {
    const cluster = makeCluster({
      'machine-a': makeMachine({ status: 'offline' }),
    })
    const proxy = createClusterProxy({ cluster })
    const result = await proxy.forwardAction({ machineId: 'machine-a', action: 'start_session' })
    expect(result.status).toBe(404)
    expect(result.body).toMatchObject({ error: expect.stringMatching(/offline/) })
  })

  it('forwards start_session with Bearer auth to target /sessions/start', async () => {
    const cluster = makeCluster({ 'machine-a': makeMachine() })
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: true, sessionId: 'abc' }))
    const proxy = createClusterProxy({ cluster, fetchImpl: fetchMock })

    const result = await proxy.forwardAction({
      machineId: 'machine-a',
      action: 'start_session',
      sessionId: 'abc',
      cwd: '/tmp/proj',
    })

    expect(result.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://alpha.local:7860/sessions/start',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer tok-alpha',
          'Content-Type': 'application/json',
        }),
      }),
    )
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)
    expect(body).toMatchObject({ sessionId: 'abc', cwd: '/tmp/proj' })
  })

  it('forwards stop_session with empty body', async () => {
    const cluster = makeCluster({ 'machine-a': makeMachine() })
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: true }))
    const proxy = createClusterProxy({ cluster, fetchImpl: fetchMock })
    await proxy.forwardAction({ machineId: 'machine-a', action: 'stop_session' })
    expect(fetchMock.mock.calls[0]![0]).toBe('http://alpha.local:7860/sessions/stop')
  })

  it('returns 502 when target responds with network error', async () => {
    const cluster = makeCluster({ 'machine-a': makeMachine() })
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const proxy = createClusterProxy({ cluster, fetchImpl: fetchMock })
    const result = await proxy.forwardAction({ machineId: 'machine-a', action: 'start_session' })
    expect(result.status).toBe(502)
    expect(result.body).toMatchObject({ error: expect.stringMatching(/unreachable/) })
  })

  it('returns 400 on unknown action', async () => {
    const cluster = makeCluster({ 'machine-a': makeMachine() })
    const proxy = createClusterProxy({ cluster })
    const result = await proxy.forwardAction({
      machineId: 'machine-a',
      action: 'rm_rf_root' as unknown as 'start_session',
    })
    expect(result.status).toBe(400)
  })

  it('preserves target error status (e.g. 409 already running)', async () => {
    const cluster = makeCluster({ 'machine-a': makeMachine() })
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ error: 'already running' }, 409))
    const proxy = createClusterProxy({ cluster, fetchImpl: fetchMock })
    const result = await proxy.forwardAction({ machineId: 'machine-a', action: 'start_session' })
    expect(result.status).toBe(409)
    expect(result.body).toMatchObject({ error: 'already running' })
  })
})

// ---------------------------------------------------------------------------
// proxyMessage()
// ---------------------------------------------------------------------------

describe('clusterProxy.proxyMessage()', () => {
  it('forwards POST body to target /messages with bearer auth', async () => {
    const cluster = makeCluster({ 'machine-a': makeMachine() })
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: true }))
    const proxy = createClusterProxy({ cluster, fetchImpl: fetchMock })

    const result = await proxy.proxyMessage('machine-a', { type: 'user', content: 'hi' })
    expect(result.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://alpha.local:7860/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer tok-alpha',
        }),
      }),
    )
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)
    expect(body).toMatchObject({ type: 'user', content: 'hi' })
  })

  it('returns 404 for offline machine', async () => {
    const cluster = makeCluster({ 'machine-a': makeMachine({ status: 'offline' }) })
    const proxy = createClusterProxy({ cluster })
    const result = await proxy.proxyMessage('machine-a', {})
    expect(result.status).toBe(404)
  })
})
