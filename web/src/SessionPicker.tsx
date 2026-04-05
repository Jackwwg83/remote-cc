// T-F09: Session selection UI — list recent sessions or start a new one
import { useState, useEffect, useCallback } from 'react'
import { getAuthHeaders } from './authUtils'

interface SessionInfo {
  id: string
  shortId: string
  project: string
  cwd: string
  time: string   // ISO timestamp
  summary: string
}

interface SessionPickerProps {
  /** Called when user selects an existing session */
  onSelect: (sessionId: string, cwd: string) => void
  /** Called when user clicks "New Session" */
  onNew: () => void
}

function formatRelativeTime(isoTime: string): string {
  const then = new Date(isoTime).getTime()
  const now = Date.now()
  const diffMs = now - then

  if (diffMs < 0) return 'just now'

  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return 'just now'

  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} min ago`

  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour} ${diffHour === 1 ? 'hour' : 'hours'} ago`

  const diffDay = Math.floor(diffHour / 24)
  return `${diffDay} ${diffDay === 1 ? 'day' : 'days'} ago`
}

export default function SessionPicker({ onSelect, onNew }: SessionPickerProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchSessions = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/sessions/history', { headers: getAuthHeaders() })
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`)
      }
      const data = await res.json() as { sessions: SessionInfo[] }
      setSessions(data.sessions ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
      <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-6">
        Select a session
      </h2>

      {/* New Session button */}
      <button
        onClick={onNew}
        className="w-full mb-6 p-4 rounded-xl border-2 border-dashed border-blue-500
          hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors
          text-left min-h-[60px] group"
      >
        <div className="flex items-center gap-3">
          <span className="text-blue-500 text-2xl leading-none select-none">+</span>
          <div>
            <p className="font-semibold text-blue-500 group-hover:text-blue-400">New Session</p>
            <p className="text-sm text-gray-500 dark:text-gray-400">Start a fresh conversation</p>
          </div>
        </div>
      </button>

      {/* Recent sessions */}
      {loading ? (
        <p className="text-center text-gray-500 dark:text-gray-400 mt-8">Loading...</p>
      ) : error ? (
        <div className="text-center mt-8">
          <p className="text-red-500 dark:text-red-400 mb-3">{error}</p>
          <button
            onClick={fetchSessions}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm
              hover:bg-blue-500 transition-colors min-h-[44px]"
          >
            Retry
          </button>
        </div>
      ) : sessions.length === 0 ? (
        <p className="text-center text-gray-500 dark:text-gray-400 mt-8">No recent sessions</p>
      ) : (
        <>
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3 uppercase tracking-wide">
            Recent sessions
          </p>
          <ul className="space-y-3">
            {sessions.map((session) => (
              <li key={session.id}>
                <button
                  onClick={() => onSelect(session.id, session.cwd)}
                  className="w-full p-4 rounded-xl bg-gray-100 dark:bg-gray-800
                    hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors
                    text-left min-h-[72px]"
                >
                  <div className="flex items-baseline justify-between gap-2 mb-1">
                    <span className="font-semibold text-gray-900 dark:text-white truncate">
                      {session.project}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
                      {formatRelativeTime(session.time)}
                    </span>
                  </div>
                  {session.summary && (
                    <p className="text-sm text-gray-600 dark:text-gray-300 line-clamp-2">
                      {session.summary}
                    </p>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
