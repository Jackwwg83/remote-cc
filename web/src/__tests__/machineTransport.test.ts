/**
 * Tests for machineTransport.ts — direct → proxy fallback.
 *
 * Uses an injected transportFactory mock so we never hit real EventSource.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { connectMachineTransport } from '../machineTransport.js'
import type { TransportState, ReconnectMeta, TransportOptions } from '../transport.js'

// ---------------------------------------------------------------------------
// Mock inner transport
// ---------------------------------------------------------------------------

interface MockTransport {
  url: string
  options: TransportOptions
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

function makeMockTransport(url: string, options: TransportOptions = {}): MockTransport {
  const messageCbs: Array<(d: unknown) => void> = []
  const stateCbs: Array<(s: TransportState, m?: ReconnectMeta) => void> = []
  let lastSeq = options.initialSeq ?? 0
  const t: MockTransport = {
    url,
    options,
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

function makeFactory(created: Array<{ url: string; options: TransportOptions; mock: MockTransport }>) {
  return vi.fn((url: string, options?: TransportOptions) => {
    const o = options ?? {}
    const t = makeMockTransport(url, o)
    created.push({ url, options: o, mock: t })
    return t as unknown as ReturnType<typeof import('../transport.js').connectTransport>
  })
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
  it('starts in direct mode with the direct URL and default paths', () => {
    const created: Array<{ url: string; options: TransportOptions; mock: MockTransport }> = []
    const mt = connectMachineTransport({ ...makeOpts(), transportFactory: makeFactory(created) })

    expect(created).toHaveLength(1)
    expect(created[0].url).toBe('http://direct.local:7860/?token=direct-tok')
    expect(created[0].options.ssePath).toBeUndefined() // default /events/stream
    expect(created[0].options.postPath).toBeUndefined() // default /messages
    expect(mt.mode).toBe('direct')
  })

  it('falls back to proxy with correct paths + extraQuery', () => {
    const created: Array<{ url: string; options: TransportOptions; mock: MockTransport }> = []
    const mt = connectMachineTransport({
      ...makeOpts({ maxDirectFailures: 2 }),
      transportFactory: makeFactory(created),
    })

    created[0].mock.fireState('reconnecting', { attempt: 1, maxAttempts: 5 })
    expect(mt.mode).toBe('direct')

    created[0].mock.fireState('reconnecting', { attempt: 2, maxAttempts: 5 })
    expect(mt.mode).toBe('proxy')
    expect(created).toHaveLength(2)
    expect(created[1].url).toContain('server.local')
    expect(created[1].url).toContain('token=cluster-tok')
    expect(created[1].options.ssePath).toBe('/cluster/stream')
    expect(created[1].options.postPath).toBe('/cluster/message')
    expect(created[1].options.extraQuery).toEqual({ machineId: 'mach-1' })
    expect(created[0].mock.close).toHaveBeenCalled()
  })

  it('preserves lastSeq across direct→proxy switch via initialSeq option', () => {
    const created: Array<{ url: string; options: TransportOptions; mock: MockTransport }> = []
    const mt = connectMachineTransport({ ...makeOpts(), transportFactory: makeFactory(created) })

    // Simulate inner collecting messages up to seq 42
    created[0].mock.setLastSeq(42)
    created[0].mock.fireMessage({ hello: 'world' })
    expect(mt.getLastSeq()).toBe(42)

    created[0].mock.fireState('disconnected')
    // New inner should receive initialSeq=42
    expect(created[1].options.initialSeq).toBe(42)
  })

  it('falls back to proxy immediately on disconnected', () => {
    const created: Array<{ url: string; options: TransportOptions; mock: MockTransport }> = []
    const mt = connectMachineTransport({ ...makeOpts(), transportFactory: makeFactory(created) })
    created[0].mock.fireState('disconnected')
    expect(mt.mode).toBe('proxy')
  })

  it('resets failure counter on connected', () => {
    const created: Array<{ url: string; options: TransportOptions; mock: MockTransport }> = []
    const mt = connectMachineTransport({
      ...makeOpts({ maxDirectFailures: 3 }),
      transportFactory: makeFactory(created),
    })
    created[0].mock.fireState('reconnecting', { attempt: 1, maxAttempts: 5 })
    created[0].mock.fireState('reconnecting', { attempt: 2, maxAttempts: 5 })
    created[0].mock.fireState('connected')
    created[0].mock.fireState('reconnecting', { attempt: 1, maxAttempts: 5 })
    created[0].mock.fireState('reconnecting', { attempt: 2, maxAttempts: 5 })
    // Still direct — counter reset
    expect(mt.mode).toBe('direct')
  })

  it('sends via inner transport (direct path)', async () => {
    const created: Array<{ url: string; options: TransportOptions; mock: MockTransport }> = []
    const mt = connectMachineTransport({ ...makeOpts(), transportFactory: makeFactory(created) })
    await mt.send({ type: 'user', text: 'hi' })
    expect(created[0].mock.send).toHaveBeenCalledWith({ type: 'user', text: 'hi' })
  })

  it('sends via inner transport (proxy path) — routed to /cluster/message via postPath', async () => {
    const created: Array<{ url: string; options: TransportOptions; mock: MockTransport }> = []
    const mt = connectMachineTransport({ ...makeOpts(), transportFactory: makeFactory(created) })
    created[0].mock.fireState('disconnected')
    expect(mt.mode).toBe('proxy')
    await mt.send({ type: 'user', text: 'hi' })
    // Second inner's send was called — it was configured with postPath=/cluster/message
    expect(created[1].mock.send).toHaveBeenCalledWith({ type: 'user', text: 'hi' })
    expect(created[1].options.postPath).toBe('/cluster/message')
  })

  it('forwards onMessage callbacks across mode switches', () => {
    const created: Array<{ url: string; options: TransportOptions; mock: MockTransport }> = []
    const mt = connectMachineTransport({ ...makeOpts(), transportFactory: makeFactory(created) })
    const received: unknown[] = []
    mt.onMessage((d) => received.push(d))

    created[0].mock.fireMessage({ a: 1 })
    created[0].mock.fireState('disconnected')
    created[1].mock.fireMessage({ b: 2 })

    expect(received).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('discards stale messages from retired inner after switch (version gate)', () => {
    const created: Array<{ url: string; options: TransportOptions; mock: MockTransport }> = []
    const mt = connectMachineTransport({ ...makeOpts(), transportFactory: makeFactory(created) })
    const received: unknown[] = []
    mt.onMessage((d) => received.push(d))

    created[0].mock.fireMessage({ a: 1 })
    created[0].mock.fireState('disconnected')
    // A late event from the retired inner must NOT reach listeners
    created[0].mock.fireMessage({ stale: true })
    created[1].mock.fireMessage({ b: 2 })

    expect(received).toEqual([{ a: 1 }, { b: 2 }])
    expect(mt.mode).toBe('proxy')
  })

  it('discards stale state events from retired inner', () => {
    const created: Array<{ url: string; options: TransportOptions; mock: MockTransport }> = []
    const mt = connectMachineTransport({ ...makeOpts(), transportFactory: makeFactory(created) })
    const states: Array<{ state: TransportState; mode?: string }> = []
    mt.onStateChange((state, meta) => states.push({ state, mode: meta?.mode }))

    created[0].mock.fireState('disconnected') // triggers switch
    // After switch, stale 'reconnecting' on the retired inner must not
    // register a failure against proxy mode.
    created[0].mock.fireState('reconnecting', { attempt: 99, maxAttempts: 99 })

    expect(mt.mode).toBe('proxy')
    // States array should only carry direct-mode initial + proxy-mode events
    // (no late 'reconnecting' from inner 0)
    const hasStaleReconnect = states.some((s) => s.state === 'reconnecting' && s.mode === 'direct')
    expect(hasStaleReconnect).toBe(false)
  })

  it('retryDirect() switches from proxy back to direct', () => {
    const created: Array<{ url: string; options: TransportOptions; mock: MockTransport }> = []
    const mt = connectMachineTransport({ ...makeOpts(), transportFactory: makeFactory(created) })
    created[0].mock.fireState('disconnected')
    expect(mt.mode).toBe('proxy')

    mt.retryDirect()
    expect(mt.mode).toBe('direct')
    expect(created).toHaveLength(3)
    expect(created[2].url).toBe('http://direct.local:7860/?token=direct-tok')
  })

  it('close() stops inner transport and ignores further events', () => {
    const created: Array<{ url: string; options: TransportOptions; mock: MockTransport }> = []
    const mt = connectMachineTransport({ ...makeOpts(), transportFactory: makeFactory(created) })
    mt.close()
    expect(created[0].mock.close).toHaveBeenCalled()
    // Late event should not spawn a new inner
    created[0].mock.fireState('disconnected')
    expect(created).toHaveLength(1)
  })

  it('getLastSeq() returns cached seq after close', () => {
    const created: Array<{ url: string; options: TransportOptions; mock: MockTransport }> = []
    const mt = connectMachineTransport({ ...makeOpts(), transportFactory: makeFactory(created) })
    created[0].mock.setLastSeq(42)
    created[0].mock.fireMessage({ ping: 1 }) // captures seq into cache
    mt.close()
    expect(mt.getLastSeq()).toBe(42)
  })

  it('includes mode in state change meta', () => {
    const created: Array<{ url: string; options: TransportOptions; mock: MockTransport }> = []
    const mt = connectMachineTransport({
      ...makeOpts({ maxDirectFailures: 1 }),
      transportFactory: makeFactory(created),
    })
    const states: Array<{ state: TransportState; mode?: string }> = []
    mt.onStateChange((state, meta) => states.push({ state, mode: meta?.mode }))

    created[0].mock.fireState('connected')
    created[0].mock.fireState('reconnecting', { attempt: 1, maxAttempts: 5 })
    created[1]?.mock.fireState('connected')

    for (const s of states) {
      expect(s.mode === 'direct' || s.mode === 'proxy').toBe(true)
    }
  })
})
