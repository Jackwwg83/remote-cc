/**
 * QuickTask.tsx — one-click cluster task submission (T-M26).
 *
 * A modal dialog that lets the user:
 *   1. Pick a target machine from the dashboard machine list
 *   2. Type a prompt
 *   3. Press "Go" to create a new session on that machine AND immediately
 *      enqueue the prompt as the first user message
 *
 * Under the hood this issues two calls:
 *   - POST /cluster/action { machineId, action: start_session }
 *   - POST /cluster/message?machineId=X { type: user, ... } (after start)
 *
 * The prompt send is retried while the machine is still in 'spawning' state
 * (heartbeat catches up within ~1s typically).
 */

import { useState, useCallback } from 'react'
import type { ClusterMachine } from './MachineDashboard'
import { getClusterHeaders, getClusterToken } from './authUtils'

interface QuickTaskProps {
  machines: ClusterMachine[]
  /** Default-selected machineId (e.g. the dashboard-highlighted one). */
  defaultMachineId?: string
  onClose: () => void
  onSubmitted?: (machineId: string) => void
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: getClusterHeaders(),
    body: JSON.stringify(body),
  })
}

export default function QuickTask({ machines, defaultMachineId, onClose, onSubmitted }: QuickTaskProps) {
  const eligible = machines.filter((m) => m.status !== 'offline')
  const [selected, setSelected] = useState<string>(defaultMachineId ?? eligible[0]?.machineId ?? '')
  const [prompt, setPrompt] = useState('')
  const [status, setStatus] = useState<'idle' | 'starting' | 'sending' | 'done' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const submit = useCallback(async () => {
    if (!selected || !prompt.trim() || !getClusterToken()) {
      setErrorMsg('Missing machine, prompt, or cluster token')
      setStatus('error')
      return
    }
    setStatus('starting')
    setErrorMsg(null)
    try {
      const startRes = await postJson('/cluster/action', {
        machineId: selected,
        action: 'start_session',
      })
      if (!startRes.ok) {
        const detail = await startRes.json().catch(() => ({}))
        throw new Error(`start_session failed: ${detail.error ?? startRes.status}`)
      }

      setStatus('sending')
      // Send the first user message via proxy. Try up to 5 times with 500ms
      // backoff — the target's session handler may take a moment to wire up.
      const url = `/cluster/message?machineId=${encodeURIComponent(selected)}`
      let lastErr = ''
      for (let attempt = 0; attempt < 5; attempt++) {
        const res = await postJson(url, {
          type: 'user',
          message: { role: 'user', content: prompt.trim() },
          parent_tool_use_id: null,
          session_id: '',
        })
        if (res.ok) {
          setStatus('done')
          onSubmitted?.(selected)
          setTimeout(onClose, 400)
          return
        }
        if (res.status === 503 || res.status === 409) {
          // Session still spawning — retry
          lastErr = `target busy (HTTP ${res.status})`
          await new Promise((r) => setTimeout(r, 500))
          continue
        }
        const detail = await res.json().catch(() => ({}))
        throw new Error(`send failed: HTTP ${res.status} ${JSON.stringify(detail)}`)
      }
      throw new Error(`timed out waiting for target to accept first message (${lastErr})`)
    } catch (err) {
      setErrorMsg((err as Error).message)
      setStatus('error')
    }
  }, [selected, prompt, onClose, onSubmitted])

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-t-2xl sm:rounded-2xl p-5 max-w-md w-full m-2 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-3">Quick Task</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Start a new session on a machine and submit your first prompt in one shot.
        </p>

        <label className="block text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
          Machine
        </label>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          disabled={status === 'starting' || status === 'sending'}
          className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-900 text-sm mb-4 border border-gray-200 dark:border-gray-700"
        >
          {eligible.length === 0 && <option value="">No online machines</option>}
          {eligible.map((m) => (
            <option key={m.machineId} value={m.machineId}>{m.name}{m.status === 'running' ? ' (busy)' : ''}</option>
          ))}
        </select>

        <label className="block text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
          Prompt
        </label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={status === 'starting' || status === 'sending'}
          rows={4}
          className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-900 text-sm mb-4 border border-gray-200 dark:border-gray-700 resize-vertical"
          placeholder="What should Claude do?"
        />

        {errorMsg && (
          <p className="text-sm text-red-500 dark:text-red-400 mb-3">{errorMsg}</p>
        )}

        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 px-3 py-2 rounded-lg bg-gray-200 dark:bg-gray-700 text-sm font-medium hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!selected || !prompt.trim() || status === 'starting' || status === 'sending'}
            className="flex-1 px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {status === 'idle' && 'Go'}
            {status === 'starting' && 'Starting…'}
            {status === 'sending' && 'Sending…'}
            {status === 'done' && 'Done ✓'}
            {status === 'error' && 'Retry'}
          </button>
        </div>
      </div>
    </div>
  )
}
