/**
 * App-level integration test for cluster mode.
 *
 * Regression coverage for the bug where the server's local SSE stream
 * emitted session_status=waiting_for_session on connect, which pushed
 * cluster-mode users out of the dashboard into the standalone picker.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mock transport BEFORE importing App
// ---------------------------------------------------------------------------

type StateCb = (state: string, meta?: unknown) => void
type MsgCb = (data: unknown) => void

interface MockTransport {
  send: ReturnType<typeof vi.fn>
  onMessage: (cb: MsgCb) => void
  onStateChange: (cb: StateCb) => void
  close: ReturnType<typeof vi.fn>
  reconnect: ReturnType<typeof vi.fn>
  getLastSeq: () => number
  fireMessage: (d: unknown) => void
  fireState: (s: string, m?: unknown) => void
}

let transportInstance: MockTransport | null = null

vi.mock('../transport', () => {
  const messageCbs: MsgCb[] = []
  const stateCbs: StateCb[] = []
  const connectTransport = vi.fn(() => {
    const t: MockTransport = {
      send: vi.fn().mockResolvedValue(true),
      onMessage(cb) { messageCbs.push(cb) },
      onStateChange(cb) { stateCbs.push(cb); cb('connecting') },
      close: vi.fn(),
      reconnect: vi.fn(),
      getLastSeq: () => 0,
      fireMessage(d) { for (const cb of messageCbs) cb(d) },
      fireState(s, m) { for (const cb of stateCbs) cb(s, m) },
    }
    transportInstance = t
    return t
  })
  return { connectTransport }
})

// Mock fetch for dashboard /cluster/status calls
function makeResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  transportInstance = null
  // Cluster mode URL: token + cluster_token both present
  Object.defineProperty(window, 'location', {
    value: { ...window.location, search: '?token=sess-tok&cluster_token=clust-tok', href: 'http://localhost/?token=sess-tok&cluster_token=clust-tok' },
    writable: true,
  })
  // matchMedia needed by theme detection
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as typeof window.matchMedia
  // localStorage polyfill
  const storage = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
      clear: () => storage.clear(),
    },
    configurable: true,
  })

  const fetchMock = vi.fn((url: string) => {
    if (typeof url === 'string' && url.includes('/cluster/status')) {
      return Promise.resolve(makeResp({
        machines: [
          { machineId: 'uuid-1', name: 'Alpha', url: 'http://alpha:7860', status: 'idle', lastSeen: Date.now() },
        ],
      }))
    }
    return Promise.resolve(makeResp({}, 404))
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.resetModules()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('App cluster mode view routing', () => {
  it('starts on dashboard when cluster_token is present in URL', async () => {
    const AppMod = await import('../App')
    const App = AppMod.default
    render(<App />)
    // Dashboard heading visible
    expect(await screen.findByText('Machines')).toBeTruthy()
    // Standalone picker heading must NOT be visible
    expect(screen.queryByText('Select a session')).toBeNull()
  })

  it('stays on dashboard when server\'s SSE emits session_status=waiting_for_session', async () => {
    const AppMod = await import('../App')
    const App = AppMod.default
    render(<App />)

    // Wait for dashboard to render
    await screen.findByText('Machines')
    // Wait for transport to be created
    await waitFor(() => expect(transportInstance).not.toBeNull())

    // Simulate server emitting its own waiting_for_session event
    transportInstance!.fireMessage({
      type: 'system',
      subtype: 'session_status',
      state: 'waiting_for_session',
    })

    // Should STILL be on dashboard (not bounced to picker)
    expect(screen.getByText('Machines')).toBeTruthy()
    expect(screen.queryByText('Select a session')).toBeNull()
  })

  it('stays on dashboard when server emits session_ended too', async () => {
    const AppMod = await import('../App')
    const App = AppMod.default
    render(<App />)
    await screen.findByText('Machines')
    await waitFor(() => expect(transportInstance).not.toBeNull())

    transportInstance!.fireMessage({
      type: 'system',
      subtype: 'session_status',
      state: 'session_ended',
      exitCode: 0,
    })

    expect(screen.getByText('Machines')).toBeTruthy()
    expect(screen.queryByText('Select a session')).toBeNull()
  })
})
