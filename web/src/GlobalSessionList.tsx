/**
 * GlobalSessionList.tsx — Unified session list across all cluster machines.
 *
 * Fetches GET /cluster/sessions (cached by default; refresh=true for a
 * fan-out live query). Sessions are sorted descending by time; each row
 * shows machine name, project, relative time, and the first user message.
 * Clicking a row resumes the session on its origin machine.
 *
 * When scoped to a single machine (machineFilter prop), filters the list.
 */

import { useState, useEffect, useCallback } from 'react'
import { getClusterHeaders } from './authUtils'
import type { ClusterMachineStatus } from './MachineDashboard'

export interface GlobalSessionInfo {
  id: string
  shortId: string
  project: string
  cwd: string
  time: string
  summary: string
  machineId: string
  machineName: string
  machineStatus: ClusterMachineStatus
}

interface GlobalSessionListProps {
  /** Only show sessions from this machine (optional). */
  machineFilter?: string
  /** Called when user selects a session. */
  onSelect: (session: GlobalSessionInfo) => void
  /** Called when user wants to start a new session on a specific machine. */
  onNew?: (machineId: string) => void
  /** Default: false (use heartbeat cache). true = fan out for fresh list. */
  initialRefresh?: boolean
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

function formatRelative(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const delta = Date.now() - then
  if (delta < 0) return 'just now'
  const sec = Math.floor(delta / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} min ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} ${hr === 1 ? 'hour' : 'hours'} ago`
  const day = Math.floor(hr / 24)
  return `${day} ${day === 1 ? 'day' : 'days'} ago`
}

export default function GlobalSessionList({
  machineFilter,
  onSelect,
  onNew,
  initialRefresh = false,
}: GlobalSessionListProps) {
  const [sessions, setSessions] = useState<GlobalSessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchList = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const url = refresh ? '/cluster/sessions?refresh=true' : '/cluster/sessions'
      const res = await fetch(url, { headers: getClusterHeaders() })
      if (!res.ok) {
        if (res.status === 404) setError('Cluster mode not enabled')
        else if (res.status === 401) setError('Unauthorized — cluster token missing or invalid')
        else setError(`Server returned ${res.status}`)
        return
      }
      const data = await res.json() as { sessions: GlobalSessionInfo[] }
      let list = data.sessions ?? []
      if (machineFilter) list = list.filter((s) => s.machineId === machineFilter)
      setSessions(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [machineFilter])

  useEffect(() => {
    fetchList(initialRefresh)
  }, [fetchList, initialRefresh])

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
          {machineFilter ? 'Sessions on this machine' : 'All sessions'}
        </h2>
        <button
          onClick={() => fetchList(true)}
          disabled={refreshing}
          className="px-3 py-1.5 text-sm rounded-lg bg-gray-100 dark:bg-gray-800
            hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
          aria-label="Refresh session list (live query)"
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {onNew && machineFilter && (
        <button
          onClick={() => onNew(machineFilter)}
          className="w-full mb-6 p-4 rounded-xl border-2 border-dashed border-blue-500
            hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors
            text-left min-h-[60px] group"
        >
          <div className="flex items-center gap-3">
            <span className="text-blue-500 text-2xl leading-none select-none">+</span>
            <div>
              <p className="font-semibold text-blue-500 group-hover:text-blue-400">New Session</p>
              <p className="text-sm text-gray-500 dark:text-gray-400">Start a fresh conversation on this machine</p>
            </div>
          </div>
        </button>
      )}

      {loading ? (
        <p className="text-center text-gray-500 dark:text-gray-400 mt-8">Loading…</p>
      ) : error ? (
        <div className="text-center mt-8">
          <p className="text-red-500 dark:text-red-400 mb-3">{error}</p>
          <button
            onClick={() => fetchList(false)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-500 transition-colors min-h-[44px]"
          >
            Retry
          </button>
        </div>
      ) : sessions.length === 0 ? (
        <p className="text-center text-gray-500 dark:text-gray-400 mt-8">No sessions</p>
      ) : (
        <ul className="space-y-3">
          {sessions.map((s) => (
            <li key={`${s.machineId}:${s.id}`}>
              <button
                onClick={() => onSelect(s)}
                disabled={s.machineStatus === 'offline'}
                className="w-full p-4 rounded-xl bg-gray-100 dark:bg-gray-800
                  hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors text-left min-h-[72px]
                  disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="font-semibold text-gray-900 dark:text-white truncate">
                    {machineFilter ? s.project : `${statusIcon(s.machineStatus)} ${s.machineName}`}
                    {!machineFilter && ` · ${s.project}`}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
                    {formatRelative(s.time)}
                  </span>
                </div>
                {s.summary && (
                  <p className="text-sm text-gray-600 dark:text-gray-300 line-clamp-2">{s.summary}</p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
