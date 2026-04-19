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

// ---------------------------------------------------------------------------
// proxyStream()
// ---------------------------------------------------------------------------

describe('clusterProxy.proxyStream()', () => {
  /** Minimal fake IncomingMessage — we only need `headers`, `url`, and EventEmitter-ish on/off/once. */
  function makeReq(opts: { lastEventId?: string; url?: string } = {}): {
    headers: Record<string, string | undefined>
    url?: string
    on: (e: string, fn: () => void) => void
    once: (e: string, fn: () => void) => void
    off: (e: string, fn: () => void) => void
    emit: (e: string) => void
  } {
    const listeners: Record<string, Array<() => void>> = {}
    return {
      headers: opts.lastEventId ? { 'last-event-id': opts.lastEventId } : {},
      url: opts.url ?? '/cluster/stream?machineId=machine-a',
      on(e, fn) { (listeners[e] ??= []).push(fn) },
      once(e, fn) { (listeners[e] ??= []).push(fn) },
      off(e, fn) { listeners[e] = (listeners[e] ?? []).filter((f) => f !== fn) },
      emit(e) { for (const f of listeners[e] ?? []) f() },
    }
  }

  /** Minimal fake ServerResponse with writable tracking. */
  function makeRes(opts: { writeReturns?: boolean[] } = {}) {
    const listeners: Record<string, Array<() => void>> = {}
    let headersSent = false
    let writableEnded = false
    const writeSequence = opts.writeReturns ?? []
    let writeIndex = 0
    const written: Buffer[] = []
    let writtenHead: { status: number; headers: Record<string, string> } | null = null

    const res = {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      writeHead(status: number, headers: Record<string, string>) {
        headersSent = true
        ;(res as unknown as { headersSent: boolean }).headersSent = true
        writtenHead = { status, headers }
      },
      write(buf: Buffer | Uint8Array): boolean {
        written.push(Buffer.from(buf))
        const r = writeIndex < writeSequence.length ? writeSequence[writeIndex++] : true
        return r as boolean
      },
      end() {
        writableEnded = true
        ;(res as unknown as { writableEnded: boolean }).writableEnded = true
      },
      once(e: string, fn: () => void) { (listeners[e] ??= []).push(fn) },
      on(e: string, fn: () => void) { (listeners[e] ??= []).push(fn) },
      off(e: string, fn: () => void) { listeners[e] = (listeners[e] ?? []).filter((f) => f !== fn) },
      emit(e: string) { for (const f of [...(listeners[e] ?? [])]) f() },
      get _writtenHead() { return writtenHead },
      get _written() { return written },
      get _writableEnded() { return writableEnded },
      get _headersSent() { return headersSent },
    }
    return res
  }

  function makeSseResponse(chunks: string[], opts: { infinite?: boolean } = {}): {
    response: Response
    cancelled: { value: boolean }
  } {
    const encoded = chunks.map((c) => new TextEncoder().encode(c))
    let i = 0
    const cancelled = { value: false }
    let pendingResolve: ((r: { done: boolean; value?: Uint8Array }) => void) | null = null

    const reader = {
      async read() {
        if (cancelled.value) return { done: true, value: undefined }
        if (i < encoded.length) return { done: false, value: encoded[i++] }
        if (!opts.infinite) return { done: true, value: undefined }
        // Infinite: park forever until cancel() resolves the pending read
        return new Promise<{ done: boolean; value?: Uint8Array }>((r) => { pendingResolve = r })
      },
      async cancel() {
        cancelled.value = true
        if (pendingResolve) {
          pendingResolve({ done: true, value: undefined })
          pendingResolve = null
        }
      },
    }
    const stream = { getReader: () => reader }
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: stream,
    } as unknown as Response
    return { response, cancelled }
  }

  it('forwards from_seq query param to target for first-switch replay', async () => {
    const cluster = makeCluster({ 'machine-a': makeMachine() })
    const fetchMock = vi.fn().mockResolvedValue(makeSseResponse(['data: hi\n\n']).response)
    const proxy = createClusterProxy({ cluster, fetchImpl: fetchMock })

    const req = makeReq({ url: '/cluster/stream?machineId=machine-a&from_seq=42&token=x' })
    const res = makeRes()
    await proxy.proxyStream('machine-a', req as never, res as never)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://alpha.local:7860/events/stream?from_seq=42',
      expect.anything(),
    )
  })

  it('forwards Last-Event-ID header to target', async () => {
    const cluster = makeCluster({ 'machine-a': makeMachine() })
    const fetchMock = vi.fn().mockResolvedValue(makeSseResponse(['data: hi\n\n']).response)
    const proxy = createClusterProxy({ cluster, fetchImpl: fetchMock })

    const req = makeReq({ lastEventId: '42' })
    const res = makeRes()
    await proxy.proxyStream('machine-a', req as never, res as never)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://alpha.local:7860/events/stream',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer tok-alpha',
          'Last-Event-ID': '42',
        }),
      }),
    )
  })

  it('returns 404 for unknown machine without opening stream', async () => {
    const cluster = makeCluster({})
    const fetchMock = vi.fn()
    const proxy = createClusterProxy({ cluster, fetchImpl: fetchMock })

    const req = makeReq()
    const res = makeRes()
    await proxy.proxyStream('missing', req as never, res as never)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(res._writtenHead?.status).toBe(404)
  })

  it('cancels upstream + returns promptly when client disconnects during backpressure', async () => {
    const cluster = makeCluster({ 'machine-a': makeMachine() })
    // Infinite upstream so cancellation is the ONLY way out
    const { response, cancelled } = makeSseResponse(['data: a\n\n'], { infinite: true })
    const fetchMock = vi.fn().mockResolvedValue(response)
    const proxy = createClusterProxy({ cluster, fetchImpl: fetchMock })

    const req = makeReq()
    const res = makeRes({ writeReturns: [false] })
    const streamPromise = proxy.proxyStream('machine-a', req as never, res as never)

    // Let the first write happen, then simulate disconnect before 'drain'
    await new Promise((r) => setImmediate(r))
    res.emit('close')

    await Promise.race([
      streamPromise,
      new Promise((_r, rej) => setTimeout(() => rej(new Error('hung')), 500)),
    ])
    // CRITICAL: upstream reader MUST be cancelled, not just the promise resolved
    expect(cancelled.value).toBe(true)
  })

  it('cancels upstream when client response closes mid-stream', async () => {
    const cluster = makeCluster({ 'machine-a': makeMachine() })
    const { response, cancelled } = makeSseResponse([], { infinite: true })
    const fetchMock = vi.fn().mockResolvedValue(response)
    const proxy = createClusterProxy({ cluster, fetchImpl: fetchMock })

    const req = makeReq()
    const res = makeRes()
    const streamPromise = proxy.proxyStream('machine-a', req as never, res as never)

    await new Promise((r) => setImmediate(r))
    // ServerResponse 'close' is the canonical peer-disconnect signal —
    // IncomingMessage 'close' is NOT reliable (fires on request completion
    // on Node >=18, not just disconnect).
    res.emit('close')

    await Promise.race([
      streamPromise,
      new Promise((_r, rej) => setTimeout(() => rej(new Error('hung')), 500)),
    ])
    expect(cancelled.value).toBe(true)
  })
})

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
