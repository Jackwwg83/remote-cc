/**
 * QuickTask — one-click prompt submission modal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import QuickTask from '../QuickTask'
import type { ClusterMachine } from '../MachineDashboard'

function makeMachine(overrides?: Partial<ClusterMachine>): ClusterMachine {
  return {
    machineId: 'mid-a',
    name: 'Alpha',
    url: 'http://alpha:7860',
    status: 'idle',
    lastSeen: Date.now(),
    ...overrides,
  }
}

function makeResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response
}

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, search: '?cluster_token=tok' },
    writable: true,
  })
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('QuickTask', () => {
  it('renders eligible machines only (excludes offline)', () => {
    render(
      <QuickTask
        machines={[makeMachine({ machineId: 'a', name: 'A' }), makeMachine({ machineId: 'b', name: 'B', status: 'offline' })]}
        onClose={() => {}}
      />,
    )
    const select = screen.getByRole('combobox') as HTMLSelectElement
    const options = Array.from(select.options).map((o) => o.value)
    expect(options).toContain('a')
    expect(options).not.toContain('b')
  })

  it('Go button POSTs start_session then /cluster/message with the prompt', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResp({ ok: true })) // start_session
      .mockResolvedValueOnce(makeResp({ ok: true })) // message
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const onSubmitted = vi.fn()
    const onClose = vi.fn()
    render(
      <QuickTask
        machines={[makeMachine({ machineId: 'a', name: 'A' })]}
        defaultMachineId="a"
        onClose={onClose}
        onSubmitted={onSubmitted}
      />,
    )

    const textarea = screen.getByPlaceholderText(/What should Claude do/i) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'implement feature X' } })
    const go = screen.getByRole('button', { name: /^Go$/ })
    await act(async () => { fireEvent.click(go); await Promise.resolve() })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    // Call 1: POST /cluster/action start_session
    expect(fetchMock.mock.calls[0][0]).toBe('/cluster/action')
    const body1 = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body1).toMatchObject({ machineId: 'a', action: 'start_session' })

    // Call 2: POST /cluster/message?machineId=a with user prompt
    expect(fetchMock.mock.calls[1][0]).toBe('/cluster/message?machineId=a')
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(body2.type).toBe('user')
    expect(body2.message.content).toBe('implement feature X')

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('a'))
  })

  it('shows an error + Retry when start_session fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeResp({ error: 'already running' }, 409))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    render(
      <QuickTask
        machines={[makeMachine({ machineId: 'a' })]}
        defaultMachineId="a"
        onClose={() => {}}
      />,
    )
    const textarea = screen.getByPlaceholderText(/What should Claude do/i)
    fireEvent.change(textarea, { target: { value: 'x' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Go/i })); await Promise.resolve() })
    await waitFor(() => expect(screen.getByText(/start_session failed/i)).toBeTruthy())
    expect(screen.getByRole('button', { name: /Retry/i })).toBeTruthy()
  })

  it('retries message send while target is still spawning (503/409 backoff)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResp({ ok: true })) // start
      .mockResolvedValueOnce(makeResp({}, 503))      // first message → busy
      .mockResolvedValueOnce(makeResp({ ok: true })) // second message → ok
    globalThis.fetch = fetchMock as unknown as typeof fetch

    render(
      <QuickTask
        machines={[makeMachine({ machineId: 'a' })]}
        defaultMachineId="a"
        onClose={() => {}}
      />,
    )
    const textarea = screen.getByPlaceholderText(/What should Claude do/i)
    fireEvent.change(textarea, { target: { value: 'hello' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Go/i })); await Promise.resolve() })
    // 1 start + 2 message attempts
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3), { timeout: 3000 })
  })

  it('disables Go when prompt is empty', () => {
    render(
      <QuickTask
        machines={[makeMachine({ machineId: 'a' })]}
        defaultMachineId="a"
        onClose={() => {}}
      />,
    )
    const go = screen.getByRole('button', { name: /Go/ }) as HTMLButtonElement
    expect(go.disabled).toBe(true)
  })
})
