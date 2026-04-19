/**
 * MachineDashboard.tsx — Overview of all machines registered with the cluster.
 *
 * Fetches GET /cluster/status at a polling interval. Renders each machine
 * with status indicator + action buttons (Start / Stop / Sessions). The
 * phone uses this as the home view when connected to a Server-role bridge.
 *
 * Status icons:
 *   🟢 running    🟡 idle    ⏳ spawning/stopping    🔴 offline
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { getClusterHeaders } from './authUtils'

export type ClusterMachineStatus = 'idle' | 'running' | 'spawning' | 'stopping' | 'offline'

export interface ClusterMachine {
  machineId: string
  name: string
  url: string
  status: ClusterMachineStatus
  sessionId?: string
  project?: string
  lastSeen: number
  os?: string
  hostname?: string
}

interface MachineDashboardProps {
  /** Click on a machine → open its session list */
  onOpenMachine: (machine: ClusterMachine) => void
  /** Click "Start new session" for a machine */
  onStartMachine?: (machine: ClusterMachine) => void
  /** Poll interval in ms. Default 15000 (matches server sweep). */
  pollIntervalMs?: number
  /** Fires after each successful /cluster/status fetch so parents can
   *  drive features that depend on the machine list (Quick Task modal etc). */
  onMachinesLoaded?: (machines: ClusterMachine[]) => void
}

function statusIcon(status: ClusterMachineStatus): string {
  switch (status) {
    case 'running':  return '🟢'
    case 'idle':     return '🟡'
    case 'spawning': return '⏳'
    case 'stopping': return '⏳'
    case 'offline':  return '🔴'
    default:         return '❓'
  }
}

function statusLabel(status: ClusterMachineStatus): string {
  switch (status) {
    case 'running':  return 'Running'
    case 'idle':     return 'Idle'
    case 'spawning': return 'Spawning…'
    case 'stopping': return 'Stopping…'
    case 'offline':  return 'Offline'
    default:         return status
  }
}

function relativeTime(ms: number): string {
  const delta = Date.now() - ms
  if (delta < 5_000) return 'just now'
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  return `${Math.floor(delta / 86_400_000)}d ago`
}

export default function MachineDashboard({
  onOpenMachine,
  onStartMachine,
  pollIntervalMs = 15_000,
  onMachinesLoaded,
}: MachineDashboardProps) {
  const [machines, setMachines] = useState<ClusterMachine[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/cluster/status', { headers: getClusterHeaders() })
      if (!res.ok) {
        if (res.status === 404) {
          setError('Cluster mode not enabled on this server')
        } else if (res.status === 401) {
          setError('Unauthorized — cluster token missing or invalid')
        } else {
          setError(`Server returned ${res.status}`)
        }
        return
      }
      const data = await res.json() as { machines: ClusterMachine[] }
      const list = data.machines ?? []
      setMachines(list)
      setError(null)
      onMachinesLoaded?.(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load machines')
    } finally {
      setLoading(false)
    }
  }, [onMachinesLoaded])

  useEffect(() => {
    fetchStatus()
    timerRef.current = setInterval(fetchStatus, pollIntervalMs)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [fetchStatus, pollIntervalMs])

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Machines</h2>
        <button
          onClick={fetchStatus}
          className="px-3 py-1.5 text-sm rounded-lg bg-gray-100 dark:bg-gray-800
            hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          aria-label="Refresh machine list"
        >
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="text-center text-gray-500 dark:text-gray-400 mt-8">Loading…</p>
      ) : error ? (
        <div className="text-center mt-8">
          <p className="text-red-500 dark:text-red-400 mb-3">{error}</p>
          <button
            onClick={fetchStatus}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-500 transition-colors min-h-[44px]"
          >
            Retry
          </button>
        </div>
      ) : machines.length === 0 ? (
        <p className="text-center text-gray-500 dark:text-gray-400 mt-8">No machines registered yet</p>
      ) : (
        <ul className="space-y-3">
          {machines.map((m) => (
            <li key={m.machineId}>
              <div
                className="w-full p-4 rounded-xl bg-gray-100 dark:bg-gray-800
                  hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors text-left"
              >
                <div className="flex items-start gap-3">
                  <span className="text-2xl leading-none select-none" aria-hidden>{statusIcon(m.status)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-semibold text-gray-900 dark:text-white truncate">{m.name}</span>
                      <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
                        {statusLabel(m.status)} · {relativeTime(m.lastSeen)}
                      </span>
                    </div>
                    <p className="text-xs font-mono text-gray-500 dark:text-gray-400 truncate mt-0.5">
                      {m.url}
                      {m.project ? ` · ${m.project}` : ''}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => onOpenMachine(m)}
                    disabled={m.status === 'offline'}
                    className="flex-1 px-3 py-2 text-sm rounded-lg bg-blue-600 text-white
                      hover:bg-blue-500 transition-colors min-h-[36px]
                      disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Sessions
                  </button>
                  {onStartMachine && (
                    <button
                      onClick={() => onStartMachine(m)}
                      disabled={m.status === 'offline' || m.status === 'running'}
                      className="flex-1 px-3 py-2 text-sm rounded-lg bg-gray-200 dark:bg-gray-700
                        hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors min-h-[36px]
                        disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      New Session
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
