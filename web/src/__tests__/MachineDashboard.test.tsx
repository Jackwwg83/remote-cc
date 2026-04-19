/**
 * Tests for MachineDashboard — fetches /cluster/status, renders machines,
 * dispatches onOpenMachine + onStartMachine callbacks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import MachineDashboard from '../MachineDashboard'
import type { ClusterMachine } from '../MachineDashboard'

function makeMachine(overrides?: Partial<ClusterMachine>): ClusterMachine {
  return {
    machineId: 'uuid-1',
    name: 'Alpha',
    url: 'http://alpha:7860',
    status: 'idle',
    lastSeen: Date.now(),
    ...overrides,
  }
}

function makeFetchResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response
}

beforeEach(() => {
  // cluster_token must be present for headers to include Authorization
  Object.defineProperty(window, 'location', {
    value: { ...window.location, search: '?cluster_token=tok-cluster' },
    writable: true,
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('MachineDashboard', () => {
  it('renders a machine list fetched from /cluster/status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse({
      machines: [
        makeMachine({ machineId: 'id-a', name: 'Alpha', status: 'idle' }),
        makeMachine({ machineId: 'id-b', name: 'Bravo', status: 'running' }),
      ],
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    render(<MachineDashboard onOpenMachine={() => {}} pollIntervalMs={1_000_000} />)

    expect(await screen.findByText('Alpha')).toBeTruthy()
    expect(await screen.findByText('Bravo')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(
      '/cluster/status',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Authorization': 'Bearer tok-cluster' }),
      }),
    )
  })

  it('shows "not enabled" on 404 from /cluster/status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse({ error: 'Cluster mode not enabled' }, 404))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    render(<MachineDashboard onOpenMachine={() => {}} pollIntervalMs={1_000_000} />)
    expect(await screen.findByText(/not enabled/i)).toBeTruthy()
  })

  it('shows Unauthorized banner on 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse({ error: 'Unauthorized' }, 401))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    render(<MachineDashboard onOpenMachine={() => {}} pollIntervalMs={1_000_000} />)
    expect(await screen.findByText(/Unauthorized/i)).toBeTruthy()
  })

  it('fires onOpenMachine when Sessions button clicked', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse({
      machines: [makeMachine({ machineId: 'id-a', name: 'Alpha', status: 'idle' })],
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const onOpen = vi.fn()
    render(<MachineDashboard onOpenMachine={onOpen} pollIntervalMs={1_000_000} />)

    const btn = await screen.findByRole('button', { name: /Sessions/i })
    fireEvent.click(btn)
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'id-a' }))
  })

  it('disables Sessions button for offline machines', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse({
      machines: [makeMachine({ machineId: 'id-a', name: 'Alpha', status: 'offline' })],
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    render(<MachineDashboard onOpenMachine={() => {}} pollIntervalMs={1_000_000} />)
    const btn = await screen.findByRole('button', { name: /Sessions/i })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows status labels including Offline', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse({
      machines: [makeMachine({ machineId: 'id-a', name: 'Alpha', status: 'offline' })],
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    render(<MachineDashboard onOpenMachine={() => {}} pollIntervalMs={1_000_000} />)
    await waitFor(() => expect(screen.getByText(/Offline/)).toBeTruthy())
  })

  it('calls onStartMachine when New Session clicked', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse({
      machines: [makeMachine({ machineId: 'id-a', name: 'Alpha', status: 'idle' })],
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const onStart = vi.fn()
    render(<MachineDashboard onOpenMachine={() => {}} onStartMachine={onStart} pollIntervalMs={1_000_000} />)

    const btn = await screen.findByRole('button', { name: /New Session/i })
    fireEvent.click(btn)
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'id-a' }))
  })
})
