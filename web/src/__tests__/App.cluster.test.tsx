/**
 * App-level integration test for cluster mode.
 *
 * Regression coverage for the bug where the server's local SSE stream
 * emitted session_status=waiting_for_session on connect, which pushed
 * cluster-mode users out of the dashboard into the standalone picker.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mock transport BEFORE importing App
// ---------------------------------------------------------------------------

type StateCb = (state: string, meta?: unknown) => void
type MsgCb = (data: unknown) => void

interface MockTransport {
  url: string
  options: Record<string, unknown>
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
  const connectTransport = vi.fn((url: string, options?: Record<string, unknown>) => {
    const messageCbs: MsgCb[] = []
    const stateCbs: StateCb[] = []
    const t: MockTransport = {
      url,
      options: options ?? {},
      send: vi.fn().mockResolvedValue(true),
      onMessage(cb) { messageCbs.push(cb) },
      onStateChange(cb) { stateCbs.push(cb); cb('connecting') },
      close: vi.fn(() => {
        // Clear global ref so callers can observe close
        if (transportInstance === t) transportInstance = null
      }),
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
  // jsdom lacks Element.scrollIntoView
  Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView

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

  it('cluster-mode dashboard does NOT open an SSE transport (no server-session bleed possible)', async () => {
    const AppMod = await import('../App')
    const App = AppMod.default
    render(<App />)

    // Wait long enough for any mount-time effects to run
    await screen.findByText('Machines')
    await new Promise((r) => setTimeout(r, 100))

    // Invariant after Fix #1: cluster mode doesn't subscribe to the
    // server's own /events/stream when on dashboard. The prior regression
    // where the server's session_status event bounced the user out of
    // dashboard to the standalone picker is now impossible by construction.
    expect(transportInstance).toBeNull()
    // Dashboard is visible; standalone picker heading is not
    expect(screen.getByText('Machines')).toBeTruthy()
    expect(screen.queryByText('Select a session')).toBeNull()
  })

  it('cluster-mode chat view opens a proxied SSE transport with machineId + cluster token', async () => {
    const AppMod = await import('../App')
    const App = AppMod.default

    // Pre-seed /cluster/status so the dashboard has a machine to pick
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/cluster/status')) {
        return Promise.resolve({
          ok: true, status: 200, headers: new Headers(),
          json: async () => ({ machines: [{ machineId: 'uuid-1', name: 'Alpha', url: 'http://alpha:7860', status: 'idle', lastSeen: Date.now() }] }),
          text: async () => '{}',
        } as unknown as Response)
      }
      if (url.includes('/cluster/action')) {
        return Promise.resolve({
          ok: true, status: 200, headers: new Headers(),
          json: async () => ({ ok: true }),
          text: async () => '{}',
        } as unknown as Response)
      }
      return Promise.resolve({ ok: false, status: 404, headers: new Headers(), json: async () => ({}), text: async () => '' } as unknown as Response)
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    render(<App />)
    await screen.findByText('Machines')
    // No transport while on dashboard
    expect(transportInstance).toBeNull()

    // Click "Sessions" on Alpha to navigate into machine session list,
    // then "New Session" to route through startClusterSession → chat view
    const sessionsBtn = await screen.findByRole('button', { name: /Sessions/i })
    await act(async () => { fireEvent.click(sessionsBtn); await Promise.resolve() })
    // Now in machineSessions view. Click New Session.
    const newBtn = await screen.findByRole('button', { name: /New Session/i })
    await act(async () => { fireEvent.click(newBtn); await new Promise((r) => setTimeout(r, 50)) })

    // Now the second useEffect should have fired → transport opened with
    // proxy options.
    await waitFor(() => expect(transportInstance).not.toBeNull())
    // The URL passed to connectTransport must carry cluster_token, and the
    // options must route SSE + POST through /cluster/* paths.
    // (The mock's makeMockTransport stores args in the url/options fields.)
    const mockRec = transportInstance as unknown as { url: string; options: Record<string, unknown> }
    expect(mockRec.url).toContain('token=clust-tok')
    expect(mockRec.options.ssePath).toBe('/cluster/stream')
    expect(mockRec.options.postPath).toBe('/cluster/message')
    expect((mockRec.options.extraQuery as Record<string, string>).machineId).toBe('uuid-1')
  })

  it('system/tool_progress events reach the indicator (not swallowed by the generic system handler)', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?token=sess-tok', href: 'http://localhost/?token=sess-tok' },
      writable: true,
    })
    vi.resetModules()

    const AppMod = await import('../App')
    const App = AppMod.default
    render(<App />)
    await waitFor(() => expect(transportInstance).not.toBeNull())

    // Fire a system-wrapped tool_progress event. If the generic system
    // handler runs first, this returns early and the indicator never appears.
    await act(async () => {
      // Flip to chat view first
      transportInstance!.fireMessage({
        type: 'system', subtype: 'session_status', state: 'running',
      })
      await Promise.resolve()
    })

    await act(async () => {
      transportInstance!.fireMessage({
        type: 'system',
        subtype: 'tool_progress',
        tool_use_id: 'use-xyz',
        tool_name: 'Bash',
        elapsed_time_seconds: 7,
      })
      await Promise.resolve()
    })

    // Indicator shows "Running Bash... 7s"
    await waitFor(() => expect(screen.getByText(/Running Bash/i)).toBeTruthy())
    expect(screen.getByText('7s')).toBeTruthy()
  })

  it('AskUserQuestion submit sends a tool_result with the originating tool_use_id (not plain text)', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?token=sess-tok', href: 'http://localhost/?token=sess-tok' },
      writable: true,
    })
    vi.resetModules()

    const AppMod = await import('../App')
    const App = AppMod.default
    render(<App />)

    await waitFor(() => expect(transportInstance).not.toBeNull())

    // Transition to chat
    await act(async () => {
      transportInstance!.fireMessage({ type: 'system', subtype: 'session_status', state: 'running' })
      await Promise.resolve()
    })

    // Fire an assistant message carrying an AskUserQuestion tool_use
    await act(async () => {
      transportInstance!.fireMessage({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'use-regress-42',
              name: 'AskUserQuestion',
              input: { questions: [{ question: 'Q1?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
            },
          ],
        },
      })
      await Promise.resolve()
    })

    // Click option + submit
    const yesBtn = await screen.findByRole('button', { name: 'Yes' })
    await act(async () => { fireEvent.click(yesBtn); await Promise.resolve() })
    const submit = await screen.findByRole('button', { name: /Submit/i })
    await act(async () => { fireEvent.click(submit); await Promise.resolve() })

    // Assert transport.send was called with the CORRECT protocol shape
    expect(transportInstance!.send).toHaveBeenCalled()
    const sentMsg = (transportInstance!.send.mock.calls[0] ?? [])[0] as Record<string, unknown>
    expect(sentMsg.type).toBe('user')
    const userMessage = sentMsg.message as Record<string, unknown>
    expect(Array.isArray(userMessage.content)).toBe(true)
    const content = userMessage.content as Array<Record<string, unknown>>
    expect(content).toHaveLength(1)
    expect(content[0].type).toBe('tool_result')
    expect(content[0].tool_use_id).toBe('use-regress-42')
    // Content text contains the Q + A
    expect(String(content[0].content)).toContain('Yes')
    expect(String(content[0].content)).toContain('Q1?')
  })

  it('QuickCommand chip /clear routes through parseSlashCommand (not sent as plain user text)', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?token=sess-tok', href: 'http://localhost/?token=sess-tok' },
      writable: true,
    })
    vi.resetModules()

    const AppMod = await import('../App')
    const App = AppMod.default
    render(<App />)
    await waitFor(() => expect(transportInstance).not.toBeNull())

    // Flip to chat + connected so QuickCommands renders enabled chips
    await act(async () => {
      transportInstance!.fireState('connected')
      transportInstance!.fireMessage({ type: 'system', subtype: 'session_status', state: 'running' })
      await Promise.resolve()
    })
    // Seed a message so /clear has something to erase
    await act(async () => {
      transportInstance!.fireMessage({
        type: 'assistant',
        message: { role: 'assistant', content: 'hello before clear' },
      })
      await Promise.resolve()
    })
    expect(screen.queryByText('hello before clear')).toBeTruthy()

    // Tap the /clear chip
    const clearChip = await screen.findByRole('button', { name: '/clear' })
    await act(async () => { fireEvent.click(clearChip); await Promise.resolve() })

    // Assert: no send() call with content === "/clear" (would mean routing regressed)
    const calls = transportInstance!.send.mock.calls
    for (const [arg] of calls) {
      const content = ((arg as Record<string, unknown>)?.message as Record<string, unknown>)?.content
      expect(content).not.toBe('/clear')
    }
    // And the seeded message is gone — confirm clear actually ran
    await waitFor(() => expect(screen.queryByText('hello before clear')).toBeNull())
  })

  it('QuickCommand chip /compact sends a control_request with request_id + subtype=compact', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?token=sess-tok', href: 'http://localhost/?token=sess-tok' },
      writable: true,
    })
    vi.resetModules()

    const AppMod = await import('../App')
    const App = AppMod.default
    render(<App />)
    await waitFor(() => expect(transportInstance).not.toBeNull())

    await act(async () => {
      transportInstance!.fireState('connected')
      transportInstance!.fireMessage({ type: 'system', subtype: 'session_status', state: 'running' })
      await Promise.resolve()
    })

    const compactChip = await screen.findByRole('button', { name: '/compact' })
    await act(async () => { fireEvent.click(compactChip); await Promise.resolve() })

    // Find the control_request call
    const controlCall = transportInstance!.send.mock.calls.find(([arg]) => (arg as Record<string, unknown>)?.type === 'control_request')
    expect(controlCall).toBeDefined()
    const msg = controlCall![0] as Record<string, unknown>
    expect(msg.type).toBe('control_request')
    expect(typeof msg.request_id).toBe('string')
    expect((msg.request as Record<string, unknown>).subtype).toBe('compact')
  })

  it('negative control: in standalone mode (no cluster_token), waiting_for_session DOES route to picker', async () => {
    // Reset URL to standalone mode
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?token=sess-tok', href: 'http://localhost/?token=sess-tok' },
      writable: true,
    })
    vi.resetModules()

    const AppMod = await import('../App')
    const App = AppMod.default
    render(<App />)

    // Standalone starts on picker. First confirm that.
    await waitFor(() => expect(transportInstance).not.toBeNull())
    expect(screen.getByText('Select a session')).toBeTruthy()

    // Transition to chat
    await act(async () => {
      transportInstance!.fireMessage({
        type: 'system',
        subtype: 'session_status',
        state: 'running',
      })
      await Promise.resolve()
    })
    // CRITICAL: confirm the transition actually moved us into chat view —
    // without this the next assertion could trivially pass on the
    // pre-existing picker DOM even if React state updates weren't
    // flushing at all.
    await waitFor(() => expect(screen.queryByText('Select a session')).toBeNull())
    expect(screen.getByPlaceholderText(/Type a message|Waiting for connection/i)).toBeTruthy()

    // Now in chat; firing waiting_for_session should bounce back to picker
    await act(async () => {
      transportInstance!.fireMessage({
        type: 'system',
        subtype: 'session_status',
        state: 'waiting_for_session',
      })
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByText('Select a session')).toBeTruthy())
    expect(screen.queryByText('Machines')).toBeNull()
  })
})
