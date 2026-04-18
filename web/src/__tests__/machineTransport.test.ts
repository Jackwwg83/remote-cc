/**
 * Tests for machineTransport.ts — direct → proxy fallback.
 *
 * Uses an injected transportFactory mock so we never hit real EventSource.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { connectMachineTransport } from '../machineTransport.js'
import type { TransportState, ReconnectMeta } from '../transport.js'

// ---------------------------------------------------------------------------
// Mock inner transport
// ---------------------------------------------------------------------------

interface MockTransport {
  url: string
  send: ReturnType<typeof vi.fn>
  onMessage: ReturnType<typeof vi.fn>
  onStateChange: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  getLastSeq: ReturnType<typeof vi.fn>
  reconnect: ReturnType<typeof vi.fn>
  fireMessage: (data: unknown) => void
  fireState: (state: TransportState, meta?: ReconnectMeta) => void
  setLastSeq: (seq: number) => void
}

function makeMockTransport(url: string): MockTransport {
  const messageCbs: Array<(d: unknown) => void> = []
  const stateCbs: Array<(s: TransportState, m?: ReconnectMeta) => void> = []
  let lastSeq = 0
  const t: MockTransport = {
    url,
    send: vi.fn().mockResolvedValue(true),
    onMessage: vi.fn((cb: (d: unknown) => void) => messageCbs.push(cb)),
    onStateChange: vi.fn((cb: (s: TransportState, m?: ReconnectMeta) => void) => {
      stateCbs.push(cb)
      try { cb('connecting') } catch { /* ignore */ }
    }),
    close: vi.fn(),
    getLastSeq: vi.fn(() => lastSeq),
    reconnect: vi.fn(),
    fireMessage(data) { for (const cb of messageCbs) cb(data) },
    fireState(state, meta) { for (const cb of stateCbs) cb(state, meta) },
    setLastSeq(seq) { lastSeq = seq },
  }
  return t
}

// ---------------------------------------------------------------------------
// Helper: build options
// ---------------------------------------------------------------------------

function makeOpts(overrides?: Record<string, unknown>) {
  return {
    machineId: 'mach-1',
    directUrl: 'http://direct.local:7860/?token=direct-tok',
    serverUrl: 'http://server.local:7860',
    clusterToken: 'cluster-tok',
    maxDirectFailures: 3,
    ...overrides,
  }
}

// crypto.randomUUID polyfill for jsdom
beforeEach(() => {
  if (!globalThis.crypto) {
    (globalThis as unknown as { crypto: { randomUUID: () => string } }).crypto = {
      randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2),
    }
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('connectMachineTransport', () => {
  it('starts in direct mode with the direct URL', () => {
    const created: MockTransport[] = []
    const factory = vi.fn((url: string) => {
      const t = makeMockTransport(url)
      created.push(t)
      return t as unknown as ReturnType<typeof import('../transport.js').connectTransport>
    })

    const mt = connectMachineTransport({
      ...makeOpts(),
      transportFactory: factory,
    })

    expect(created).toHaveLength(1)
    expect(created[0].url).toBe('http://direct.local:7860/?token=direct-tok')
    expect(mt.mode).toBe('direct')
  })

  it('falls back to proxy after maxDirectFailures reconnect events', () => {
    const created: MockTransport[] = []
    const factory = vi.fn((url: string) => {
      const t = makeMockTransport(url)
      created.push(t)
      return t as unknown as ReturnType<typeof import('../transport.js').connectTransport>
    })

    const mt = connectMachineTransport({
      ...makeOpts({ maxDirectFailures: 2 }),
      transportFactory: factory,
    })

    const direct = created[0]
    direct.fireState('reconnecting', { attempt: 1, maxAttempts: 5 })
    expect(mt.mode).toBe('direct')

    direct.fireState('reconnecting', { attempt: 2, maxAttempts: 5 })
    expect(mt.mode).toBe('proxy')
    expect(created).toHaveLength(2)
    expect(created[1].url).toContain('/cluster/stream')
    expect(created[1].url).toContain('machineId=mach-1')
    expect(created[1].url).toContain('token=cluster-tok')
    expect(direct.close).toHaveBeenCalled()
  })

  it('falls back to proxy immediately when direct goes to disconnected', () => {
    const created: MockTransport[] = []
    const factory = vi.fn((url: string) => {
      const t = makeMockTransport(url)
      created.push(t)
      return t as unknown as ReturnType<typeof import('../transport.js').connectTransport>
    })
    const mt = connectMachineTransport({
      ...makeOpts(),
      transportFactory: factory,
    })
    const direct = created[0]
    direct.fireState('disconnected')
    expect(mt.mode).toBe('proxy')
  })

  it('resets failure counter on connected', () => {
    const created: MockTransport[] = []
    const factory = vi.fn((url: string) => {
      const t = makeMockTransport(url)
      created.push(t)
      return t as unknown as ReturnType<typeof import('../transport.js').connectTransport>
    })
    const mt = connectMachineTransport({
      ...makeOpts({ maxDirectFailures: 3 }),
      transportFactory: factory,
    })
    const direct = created[0]
    direct.fireState('reconnecting', { attempt: 1, maxAttempts: 5 })
    direct.fireState('reconnecting', { attempt: 2, maxAttempts: 5 })
    direct.fireState('connected')
    direct.fireState('reconnecting', { attempt: 1, maxAttempts: 5 })
    direct.fireState('reconnecting', { attempt: 2, maxAttempts: 5 })
    // Still direct — counter reset
    expect(mt.mode).toBe('direct')
  })

  it('sends via direct transport in direct mode', async () => {
    const created: MockTransport[] = []
    const factory = vi.fn((url: string) => {
      const t = makeMockTransport(url)
      created.push(t)
      return t as unknown as ReturnType<typeof import('../transport.js').connectTransport>
    })
    const mt = connectMachineTransport({
      ...makeOpts(),
      transportFactory: factory,
    })
    await mt.send({ type: 'user', text: 'hi' })
    expect(created[0].send).toHaveBeenCalledWith({ type: 'user', text: 'hi' })
  })

  it('sends via /cluster/message in proxy mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    // Replace global fetch
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const created: MockTransport[] = []
    const factory = vi.fn((url: string) => {
      const t = makeMockTransport(url)
      created.push(t)
      return t as unknown as ReturnType<typeof import('../transport.js').connectTransport>
    })
    const mt = connectMachineTransport({
      ...makeOpts(),
      transportFactory: factory,
    })
    created[0].fireState('disconnected')
    expect(mt.mode).toBe('proxy')

    await mt.send({ type: 'user', text: 'hi' })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/cluster/message?machineId=mach-1'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer cluster-tok',
        }),
      }),
    )
    globalThis.fetch = originalFetch
  })

  it('forwards onMessage callbacks across mode switches', () => {
    const created: MockTransport[] = []
    const factory = vi.fn((url: string) => {
      const t = makeMockTransport(url)
      created.push(t)
      return t as unknown as ReturnType<typeof import('../transport.js').connectTransport>
    })
    const mt = connectMachineTransport({
      ...makeOpts(),
      transportFactory: factory,
    })
    const received: unknown[] = []
    mt.onMessage((d) => received.push(d))

    created[0].fireMessage({ a: 1 })
    created[0].fireState('disconnected')
    // now in proxy
    created[1].fireMessage({ b: 2 })

    expect(received).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('retryDirect() switches from proxy back to direct', () => {
    const created: MockTransport[] = []
    const factory = vi.fn((url: string) => {
      const t = makeMockTransport(url)
      created.push(t)
      return t as unknown as ReturnType<typeof import('../transport.js').connectTransport>
    })
    const mt = connectMachineTransport({
      ...makeOpts(),
      transportFactory: factory,
    })
    created[0].fireState('disconnected')
    expect(mt.mode).toBe('proxy')

    mt.retryDirect()
    expect(mt.mode).toBe('direct')
    expect(created).toHaveLength(3)
    expect(created[2].url).toBe('http://direct.local:7860/?token=direct-tok')
  })

  it('close() stops inner transport and ignores further events', () => {
    const created: MockTransport[] = []
    const factory = vi.fn((url: string) => {
      const t = makeMockTransport(url)
      created.push(t)
      return t as unknown as ReturnType<typeof import('../transport.js').connectTransport>
    })
    const mt = connectMachineTransport({
      ...makeOpts(),
      transportFactory: factory,
    })
    mt.close()
    expect(created[0].close).toHaveBeenCalled()
    // firing more events after close should NOT create a new inner
    created[0].fireState('disconnected')
    expect(created).toHaveLength(1)
  })

  it('getLastSeq() returns the inner transport seq', () => {
    const created: MockTransport[] = []
    const factory = vi.fn((url: string) => {
      const t = makeMockTransport(url)
      created.push(t)
      return t as unknown as ReturnType<typeof import('../transport.js').connectTransport>
    })
    const mt = connectMachineTransport({
      ...makeOpts(),
      transportFactory: factory,
    })
    created[0].setLastSeq(42)
    expect(mt.getLastSeq()).toBe(42)
  })

  it('includes mode in state change meta', () => {
    const created: MockTransport[] = []
    const factory = vi.fn((url: string) => {
      const t = makeMockTransport(url)
      created.push(t)
      return t as unknown as ReturnType<typeof import('../transport.js').connectTransport>
    })
    const mt = connectMachineTransport({
      ...makeOpts({ maxDirectFailures: 1 }),
      transportFactory: factory,
    })
    const states: Array<{ state: TransportState; mode?: string }> = []
    mt.onStateChange((state, meta) => states.push({ state, mode: meta?.mode }))

    created[0].fireState('connected')
    created[0].fireState('reconnecting', { attempt: 1, maxAttempts: 5 })
    // after max failures → proxy
    created[1]?.fireState('connected')

    // All emitted states should carry a mode
    for (const s of states) {
      expect(s.mode === 'direct' || s.mode === 'proxy').toBe(true)
    }
  })
})
