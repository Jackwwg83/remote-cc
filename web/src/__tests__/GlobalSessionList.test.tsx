/**
 * Tests for GlobalSessionList — fetches /cluster/sessions (cached + refresh),
 * filters by machine, dispatches onSelect + onNew callbacks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import GlobalSessionList from '../GlobalSessionList'
import type { GlobalSessionInfo } from '../GlobalSessionList'

function makeSession(overrides?: Partial<GlobalSessionInfo>): GlobalSessionInfo {
  return {
    id: 'sess-1',
    shortId: 'ss01',
    project: 'demo',
    cwd: '/demo',
    time: '2026-04-18T10:00:00Z',
    summary: 'hello world',
    machineId: 'uuid-a',
    machineName: 'Alpha',
    machineStatus: 'idle',
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
    value: { ...window.location, search: '?cluster_token=tok-cluster' },
    writable: true,
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('GlobalSessionList', () => {
  it('fetches cached /cluster/sessions by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp({
      sessions: [makeSession({ id: 's1', summary: 'First' })],
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    render(<GlobalSessionList onSelect={() => {}} />)
    expect(await screen.findByText('First')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(
      '/cluster/sessions',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Authorization': 'Bearer tok-cluster' }),
      }),
    )
  })

  it('fetches live ?refresh=true when Refresh button clicked', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResp({ sessions: [makeSession({ id: 's1', summary: 'cached' })] }))
      .mockResolvedValueOnce(makeResp({ sessions: [makeSession({ id: 's2', summary: 'live' })] }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    render(<GlobalSessionList onSelect={() => {}} />)
    await screen.findByText('cached')

    const refreshBtn = screen.getByRole('button', { name: /Refresh/i })
    fireEvent.click(refreshBtn)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls[1][0]).toBe('/cluster/sessions?refresh=true')
    await screen.findByText('live')
  })

  it('filters by machineId when machineFilter prop is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp({
      sessions: [
        makeSession({ id: 's1', machineId: 'a', summary: 'on A' }),
        makeSession({ id: 's2', machineId: 'b', summary: 'on B' }),
      ],
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    render(<GlobalSessionList machineFilter="a" onSelect={() => {}} />)
    expect(await screen.findByText('on A')).toBeTruthy()
    expect(screen.queryByText('on B')).toBeNull()
  })

  it('fires onSelect with the session when a row is clicked', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp({
      sessions: [makeSession({ id: 's1', summary: 'pick me' })],
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const onSelect = vi.fn()
    render(<GlobalSessionList onSelect={onSelect} />)
    const row = await screen.findByText('pick me')
    fireEvent.click(row.closest('button')!)
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }))
  })

  it('disables offline machine sessions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp({
      sessions: [makeSession({ id: 's1', machineStatus: 'offline', summary: 'offline sess' })],
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    render(<GlobalSessionList onSelect={() => {}} />)
    const row = await screen.findByText('offline sess')
    const btn = row.closest('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('shows New Session button when machineFilter + onNew are both provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp({ sessions: [] }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const onNew = vi.fn()
    render(<GlobalSessionList machineFilter="mach-1" onSelect={() => {}} onNew={onNew} />)
    const newBtn = await screen.findByRole('button', { name: /New Session/i })
    fireEvent.click(newBtn)
    expect(onNew).toHaveBeenCalledWith('mach-1')
  })

  it('shows 401 error on unauthorized', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp({}, 401))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    render(<GlobalSessionList onSelect={() => {}} />)
    expect(await screen.findByText(/Unauthorized/i)).toBeTruthy()
  })
})
