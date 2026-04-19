// T-10/T-13/T-14/T-19-21/T-32-34/T-F10/T-S08: Chat interface with streaming, permission approval, reconnect, session picker for remote-cc web UI

import { useState, useEffect, useRef, useCallback } from 'react'
import { connectTransport, type TransportState, type ReconnectMeta, type TransportOptions } from './transport'
import MessageRenderer, { type ChatMessage } from './MessageRenderer'
import { createStreamingState, streamingToContent, type StreamingMessage } from './streamingState'
import PermissionDialog, { type PermissionRequest, type PermissionAction } from './PermissionDialog'
import InstallPrompt from './InstallPrompt'
import QuickCommands from './QuickCommands'
import SessionPicker from './SessionPicker'
import MachineDashboard, { type ClusterMachine } from './MachineDashboard'
import GlobalSessionList, { type GlobalSessionInfo } from './GlobalSessionList'
import { getClusterToken, getClusterHeaders } from './authUtils'
import ProgressIndicator from './ProgressIndicator'
import { parseSlashCommand, sumUsage, type CumulativeUsage } from './SlashCommandHandler'
import QuickTask from './QuickTask'

/** System subtypes that are internal/technical — never shown in chat.
 *  T-M21: api_retry / rate_limit / rate_limit_event moved OUT so StatusMessage
 *  can surface them as inline indicators (retry spinner / rate-limit warning). */
const SKIP_SUBTYPES = new Set([
  'init', 'hook_started', 'hook_response', 'hook_progress',
  'compact_boundary', 'microcompact_boundary',
  'task_started', 'task_progress', 'task_notification',
  'session_state_changed', 'files_persisted',
  'session_status',
])

// Auth utils — import for internal use + re-export for backward compat
import { getAuthHeaders } from './authUtils'
export { getAuthHeaders }

function getTransportUrl(): string {
  // The transport extracts origin + token from the full page URL
  return window.location.href
}

export default function App() {
  const [status, setStatus] = useState<TransportState>('disconnected')
  // T-34: Track reconnect attempt for UI display
  const [reconnectInfo, setReconnectInfo] = useState<ReconnectMeta | null>(null)
  // T-34: "Reconnected" banner that auto-dismisses after 3s
  const [showReconnected, setShowReconnected] = useState(false)
  const reconnectedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevStatusRef = useRef<TransportState>('disconnected')

  // B-06: Dark/light theme toggle
  const [theme, setTheme] = useState(() =>
    localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  )

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('theme', theme)
  }, [theme])

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamingMsg, setStreamingMsg] = useState<StreamingMessage | null>(null)
  const [input, setInput] = useState('')
  // T-19: Pending permission requests (Map<request_id, PermissionRequest>)
  const [pendingPerms, setPendingPerms] = useState<Map<string, PermissionRequest>>(new Map())
  // Cluster mode: dashboard → machineSessions (picker for single machine) → chat
  // Standalone: picker → chat (existing behavior)
  const isClusterMode = Boolean(getClusterToken())
  const [view, setView] = useState<'dashboard' | 'picker' | 'machineSessions' | 'chat'>(
    isClusterMode ? 'dashboard' : 'picker',
  )
  // When in cluster mode, tracks the currently-targeted machine (null = server itself)
  const [targetMachine, setTargetMachine] = useState<ClusterMachine | null>(null)
  // T-M16: active tool_progress indicators, keyed by tool_use_id
  const [toolProgress, setToolProgress] = useState<Map<string, { toolName: string; elapsedSeconds: number }>>(new Map())
  // T-M18: cumulative usage tracking for /cost command
  const [cumulativeUsage, setCumulativeUsage] = useState<CumulativeUsage>({ inputTokens: 0, outputTokens: 0, totalCostUsd: 0, turnCount: 0 })
  const [showCostOverlay, setShowCostOverlay] = useState(false)
  // T-M26: Quick Task modal + cached machine list for its dropdown
  const [showQuickTask, setShowQuickTask] = useState(false)
  const [dashboardMachines, setDashboardMachines] = useState<ClusterMachine[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<ReturnType<typeof connectTransport> | null>(null)
  const streamStateRef = useRef(createStreamingState())

  // T-14: rAF throttling refs — survive re-renders without triggering them
  const pendingUpdateRef = useRef<StreamingMessage | null>(null)
  const rafIdRef = useRef<number | null>(null)

  const scheduleRender = useCallback((msg: StreamingMessage) => {
    pendingUpdateRef.current = msg
    if (!rafIdRef.current) {
      rafIdRef.current = requestAnimationFrame(() => {
        if (pendingUpdateRef.current) {
          setStreamingMsg(pendingUpdateRef.current)
        }
        rafIdRef.current = null
      })
    }
  }, [])

  // Auto-scroll to bottom on new messages or streaming updates
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingMsg])

  // Connect SSE transport.
  //
  // Standalone mode: open a single transport against the bridge's own
  // /events/stream on mount (existing behavior, unchanged).
  //
  // Cluster mode: only open a transport when we enter chat view with a
  // selected target machine (see the SECOND useEffect below). SSE goes
  // through /cluster/stream?machineId=X via the cluster proxy using the
  // cluster token (the per-machine sessionToken is redacted from
  // /cluster/status for security, so we never have direct-connect creds
  // — always proxy).
  useEffect(() => {
    if (isClusterMode) return undefined // cluster path handled below

    const baseUrl = getTransportUrl()
    const opts: TransportOptions = {}
    const transport = connectTransport(baseUrl, opts)
    wsRef.current = transport
    const ss = streamStateRef.current

    // T-34: Handle state changes with reconnect metadata
    transport.onStateChange((state: TransportState, meta?: ReconnectMeta) => {
      const prev = prevStatusRef.current
      prevStatusRef.current = state

      setStatus(state)
      setReconnectInfo(state === 'reconnecting' && meta ? meta : null)

      // T-34: Show "Reconnected" banner when transitioning from reconnecting to connected
      if (state === 'connected' && (prev === 'reconnecting' || prev === 'connecting')) {
        // Only show if we were actually reconnecting (not initial connect)
        if (prev === 'reconnecting') {
          setShowReconnected(true)
          if (reconnectedTimerRef.current) clearTimeout(reconnectedTimerRef.current)
          reconnectedTimerRef.current = setTimeout(() => {
            setShowReconnected(false)
            reconnectedTimerRef.current = null
          }, 3000)
        }
      }
    })

    transport.onMessage((data) => {
      if (!data || typeof data !== 'object' || !('type' in (data as Record<string, unknown>))) return

      const d = data as Record<string, unknown>

      // T-13: Route partial messages through streaming state machine
      if (d.type === 'assistant' && d.subtype === 'partial') {
        const event = d.event as Record<string, unknown> | undefined

        // B-02: message_stop — just clear streaming preview. The full assistant
        // message will arrive as a separate non-partial message and be added to
        // messages there, preventing duplicates.
        if (event?.type === 'message_stop') {
          ss.handlePartial(data)
          ss.finalize()
          // Flush any pending rAF
          if (rafIdRef.current) {
            cancelAnimationFrame(rafIdRef.current)
            rafIdRef.current = null
          }
          pendingUpdateRef.current = null
          setStreamingMsg(null)
          return
        }

        // Other partial events: update streaming state, throttle render
        const updated = ss.handlePartial(data)
        if (updated) {
          scheduleRender(updated)
        }
        return
      }

      // Complete assistant message: replace any streaming state
      if (d.type === 'assistant' && d.subtype !== 'partial') {
        // Cancel streaming if active
        ss.reset()
        if (rafIdRef.current) {
          cancelAnimationFrame(rafIdRef.current)
          rafIdRef.current = null
        }
        pendingUpdateRef.current = null
        setStreamingMsg(null)

        // T-M16: clear tool_progress for tools whose tool_result arrived
        const content = (d.message as Record<string, unknown>)?.content
        if (Array.isArray(content)) {
          const resolvedIds = new Set<string>()
          for (const block of content) {
            if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_result') {
              const id = (block as Record<string, unknown>).tool_use_id as string | undefined
              if (id) resolvedIds.add(id)
            }
          }
          if (resolvedIds.size > 0) {
            setToolProgress((prev) => {
              let changed = false
              const next = new Map(prev)
              for (const id of resolvedIds) {
                if (next.delete(id)) changed = true
              }
              return changed ? next : prev
            })
          }
        }

        setMessages((prev) => [...prev, data as ChatMessage])
        return
      }

      // B-01: User message replay — only show real user text messages
      // B-08: Skip tool_result, tool_use, and other non-text content
      if (d.type === 'user') {
        const msg = d as Record<string, unknown>
        const content = (msg.message as Record<string, unknown>)?.content
        // Only show if content is a plain string (real user input)
        if (typeof content === 'string' && content.trim()) {
          setMessages((prev) => [...prev, data as ChatMessage])
        }
        // Array content (tool_result, images, etc.) = not a real user message → skip
        return
      }

      // T-19: control_request (permission approval)
      if (d.type === 'control_request') {
        const req = data as PermissionRequest
        if (req.request?.subtype === 'can_use_tool') {
          setPendingPerms((prev) => {
            const next = new Map(prev)
            next.set(req.request_id, req)
            return next
          })
        }
        return
      }

      // T-F10: Handle session_status messages to switch between picker and chat.
      // In cluster mode, the server's local SSE emits these events for the
      // server's own bridge — they must NOT force the user out of the
      // dashboard/machineSessions/chat flow that targets another machine.
      // We only act on session_status when in standalone mode.
      if (d.type === 'system' && d.subtype === 'session_status') {
        if (isClusterMode) return
        const sessionState = d.state as string
        if (sessionState === 'waiting_for_session') {
          setView('picker')
        } else if (sessionState === 'running') {
          setView('chat')
        } else if (sessionState === 'session_ended') {
          // Clear chat state for next session
          setMessages([])
          setStreamingMsg(null)
          setPendingPerms(new Map())
          streamStateRef.current.reset()
          setView('picker')
        }
        return  // Don't add to messages
      }

      // T-M16: tool_progress — check BEFORE the generic system-skip branch
      // below, since tool_progress arrives as both top-level and as a
      // system-wrapped subtype depending on the engine version. The generic
      // system handler returns early, which would otherwise starve this one.
      if (d.type === 'tool_progress' || (d.type === 'system' && d.subtype === 'tool_progress')) {
        const raw = d as Record<string, unknown>
        const id = (raw.tool_use_id ?? raw.toolUseId) as string | undefined
        const toolName = (raw.tool_name ?? raw.toolName ?? 'Tool') as string
        const elapsed = (raw.elapsed_time_seconds ?? raw.elapsedSeconds ?? 0) as number
        if (id) {
          setToolProgress((prev) => {
            const next = new Map(prev)
            next.set(id, { toolName, elapsedSeconds: elapsed })
            return next
          })
        }
        return
      }

      // Filter: only show user-visible system messages
      if (d.type === 'system') {
        const sub = (d as Record<string, unknown>).subtype as string
        // Skip technical messages (init, hooks, compact boundaries)
        // B-03: Skip all technical/internal system subtypes
        if (!SKIP_SUBTYPES.has(sub)) {
          setMessages((prev) => [...prev, data as ChatMessage])
        }
        return
      }

      // Result message: T-M17 tracks cumulative usage; surface as a result
      // message so CostFooter renders below the assistant reply. Errors also
      // surface as a status message (existing behavior).
      if (d.type === 'result') {
        const result = d as Record<string, unknown>
        if (result.is_error || result.subtype === 'error') {
          setMessages((prev) => [...prev, {
            type: 'system',
            subtype: 'status',
            text: `Error: ${(result.result as string) || 'Unknown error'}`,
            _original: data,
          } as unknown as ChatMessage])
        } else {
          // Normal result — append as 'result' type so MessageRenderer shows
          // the CostFooter.
          setMessages((prev) => [...prev, data as ChatMessage])
          // Update cumulative totals. Use sumUsage's turnCount so "turns"
          // reflect actual token-bearing exchanges — a result with no usage
          // (e.g. protocol-only no-op) shouldn't bump the counter.
          setCumulativeUsage((prev) => {
            const thisTurn = sumUsage([result as Parameters<typeof sumUsage>[0][number]])
            return {
              inputTokens: prev.inputTokens + thisTurn.inputTokens,
              outputTokens: prev.outputTokens + thisTurn.outputTokens,
              totalCostUsd: prev.totalCostUsd + thisTurn.totalCostUsd,
              turnCount: prev.turnCount + thisTurn.turnCount,
            }
          })
        }
        // Clear any lingering tool_progress for this turn
        setToolProgress(new Map())
        return
      }

    })

    return () => {
      transport.close()
      wsRef.current = null
      // Clean up rAF on unmount
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      // Clean up reconnected banner timer
      if (reconnectedTimerRef.current) {
        clearTimeout(reconnectedTimerRef.current)
        reconnectedTimerRef.current = null
      }
    }
  }, [scheduleRender, isClusterMode])

  // Cluster chat transport: opens when view === 'chat' + targetMachine is set.
  // Duplicates the handler wiring of the standalone effect above because the
  // two effects are never simultaneously active (isClusterMode flips the
  // branch). Kept separate rather than merged to avoid churning the stable
  // standalone codepath with new dependencies.
  useEffect(() => {
    if (!isClusterMode) return undefined
    if (view !== 'chat') return undefined
    if (!targetMachine) return undefined
    const clusterTok = getClusterToken()
    if (!clusterTok) return undefined

    const u = new URL(window.location.href)
    u.search = `?token=${encodeURIComponent(clusterTok)}`
    const baseUrl = u.toString()
    const opts: TransportOptions = {
      ssePath: '/cluster/stream',
      postPath: '/cluster/message',
      extraQuery: { machineId: targetMachine.machineId },
    }

    const transport = connectTransport(baseUrl, opts)
    wsRef.current = transport
    const ss = streamStateRef.current

    transport.onStateChange((state: TransportState, meta?: ReconnectMeta) => {
      setStatus(state)
      setReconnectInfo(state === 'reconnecting' && meta ? meta : null)
    })

    transport.onMessage((data) => {
      if (!data || typeof data !== 'object' || !('type' in (data as Record<string, unknown>))) return
      const d = data as Record<string, unknown>

      if (d.type === 'assistant' && d.subtype === 'partial') {
        const event = d.event as Record<string, unknown> | undefined
        if (event?.type === 'message_stop') {
          ss.handlePartial(data); ss.finalize()
          if (rafIdRef.current) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null }
          pendingUpdateRef.current = null
          setStreamingMsg(null)
          return
        }
        const updated = ss.handlePartial(data)
        if (updated) scheduleRender(updated)
        return
      }

      if (d.type === 'assistant' && d.subtype !== 'partial') {
        ss.reset()
        if (rafIdRef.current) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null }
        pendingUpdateRef.current = null
        setStreamingMsg(null)

        // T-M16 tool_progress clear
        const content = (d.message as Record<string, unknown>)?.content
        if (Array.isArray(content)) {
          const resolvedIds = new Set<string>()
          for (const block of content) {
            if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_result') {
              const id = (block as Record<string, unknown>).tool_use_id as string | undefined
              if (id) resolvedIds.add(id)
            }
          }
          if (resolvedIds.size > 0) {
            setToolProgress((prev) => {
              const next = new Map(prev)
              for (const id of resolvedIds) next.delete(id)
              return next
            })
          }
        }
        setMessages((prev) => [...prev, data as ChatMessage])
        return
      }

      if (d.type === 'user') {
        const content = (d.message as Record<string, unknown>)?.content
        if (typeof content === 'string' && content.trim()) {
          setMessages((prev) => [...prev, data as ChatMessage])
        }
        return
      }

      if (d.type === 'control_request') {
        const req = data as PermissionRequest
        if (req.request?.subtype === 'can_use_tool') {
          setPendingPerms((prev) => { const next = new Map(prev); next.set(req.request_id, req); return next })
        }
        return
      }

      if (d.type === 'tool_progress' || (d.type === 'system' && d.subtype === 'tool_progress')) {
        const raw = d as Record<string, unknown>
        const id = (raw.tool_use_id ?? raw.toolUseId) as string | undefined
        const toolName = (raw.tool_name ?? raw.toolName ?? 'Tool') as string
        const elapsed = (raw.elapsed_time_seconds ?? raw.elapsedSeconds ?? 0) as number
        if (id) {
          setToolProgress((prev) => { const next = new Map(prev); next.set(id, { toolName, elapsedSeconds: elapsed }); return next })
        }
        return
      }

      if (d.type === 'result') {
        const result = d as Record<string, unknown>
        if (result.is_error || result.subtype === 'error') {
          setMessages((prev) => [...prev, {
            type: 'system', subtype: 'status',
            text: `Error: ${(result.result as string) || 'Unknown error'}`,
          } as unknown as ChatMessage])
        } else {
          setMessages((prev) => [...prev, data as ChatMessage])
          setCumulativeUsage((prev) => {
            const thisTurn = sumUsage([result as Parameters<typeof sumUsage>[0][number]])
            return {
              inputTokens: prev.inputTokens + thisTurn.inputTokens,
              outputTokens: prev.outputTokens + thisTurn.outputTokens,
              totalCostUsd: prev.totalCostUsd + thisTurn.totalCostUsd,
              turnCount: prev.turnCount + thisTurn.turnCount,
            }
          })
        }
        setToolProgress(new Map())
        return
      }
    })

    return () => {
      transport.close()
      wsRef.current = null
    }
  }, [isClusterMode, view, targetMachine, scheduleRender])

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || !wsRef.current) return

    // T-M18: intercept slash commands before sending
    const slash = parseSlashCommand(text)
    if (slash.handled) {
      setInput('')
      if (slash.kind === 'clear') {
        setMessages([])
        setStreamingMsg(null)
        setPendingPerms(new Map())
        streamStateRef.current.reset()
        if (slash.confirm) {
          setMessages([{ type: 'system', subtype: 'status', text: slash.confirm } as unknown as ChatMessage])
        }
        return
      }
      if (slash.kind === 'cost') {
        setShowCostOverlay(true)
        return
      }
      if (slash.kind === 'noop') {
        setMessages((prev) => [...prev, { type: 'system', subtype: 'status', text: slash.feedback } as unknown as ChatMessage])
        return
      }
      if (slash.kind === 'send_control') {
        await wsRef.current.send(slash.controlMsg)
        return
      }
    }

    const msg: ChatMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    }

    // B-01: No local echo — user messages are added only when replayed from
    // the server via SSE, preventing duplicates.
    setInput('')  // Clear immediately for responsiveness
    const ok = await wsRef.current.send(msg)
    if (!ok) {
      console.error('Failed to send message')
    }
  }, [input])

  // IME composition guard — don't submit while composing (Chinese/Japanese/Korean input)
  const isComposingRef = useRef(false)

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
      e.preventDefault()
      sendMessage()
    }
  }

  // T-20: Send control_response and remove from pending
  const handlePermission = useCallback(async (action: PermissionAction) => {
    if (!wsRef.current) return

    let ok = false
    if (action.behavior === 'allow') {
      ok = await wsRef.current.send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: action.requestId,
          response: { behavior: 'allow', updatedInput: {} },
        },
      })
    } else if (action.behavior === 'always_allow') {
      ok = await wsRef.current.send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: action.requestId,
          response: {
            behavior: 'allow',
            updatedInput: {},
            updatedPermissions: [{
              type: 'addRules',
              rules: [{ toolName: action.toolName }],
              behavior: 'allow',
              destination: 'localSettings',
            }],
          },
        },
      })
    } else {
      ok = await wsRef.current.send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: action.requestId,
          response: { behavior: 'deny', message: 'User denied this operation' },
        },
      })
    }

    // Only dismiss the dialog if the response was delivered.
    // If send failed, keep the dialog so the user can retry.
    if (ok) {
      setPendingPerms((prev) => {
        const next = new Map(prev)
        next.delete(action.requestId)
        return next
      })
    } else {
      console.error('Failed to send permission response — dialog kept for retry')
    }
  }, [])

  // T-M19: handler for AskUserQuestion option clicks — sends a tool_result
  // correlated to the original tool_use_id so Claude's agent loop can link
  // the answer back to the originating AskUserQuestion call. Sending plain
  // text without the id leaves the tool call "dangling" in the protocol.
  const handleAnswerQuestion = useCallback(async (
    toolUseId: string,
    answers: Array<{ question: string; answer: string }>,
  ) => {
    if (!wsRef.current) return
    const summary = answers
      .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
      .join('\n\n')
    await wsRef.current.send({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: summary,
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: '',
    })
  }, [])

  // Cluster mode: start/resume a session on a target machine via /cluster/action.
  // After the action succeeds we move to chat view; the SSE transport useEffect
  // opens a proxied /cluster/stream?machineId=X connection once view === 'chat'
  // + targetMachine is set.
  const startClusterSession = useCallback(async (machineId: string, sessionId?: string) => {
    try {
      const body: Record<string, string> = { machineId, action: 'start_session' }
      if (sessionId) body.sessionId = sessionId
      const res = await fetch('/cluster/action', {
        method: 'POST',
        headers: getClusterHeaders(),
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        console.error('Cluster start_session failed:', data.error)
        return
      }
      // If caller hasn't already set targetMachine, look it up so the
      // transport effect knows which machine to proxy to.
      setTargetMachine((prev) => {
        if (prev && prev.machineId === machineId) return prev
        const m = dashboardMachines.find((x) => x.machineId === machineId)
        return m ?? prev
      })
      setView('chat')
    } catch (err) {
      console.error('Cluster start_session error:', err)
    }
  }, [dashboardMachines])

  // T-F10: Start a new or existing session via REST API
  const startSession = useCallback(async (sessionId?: string, cwd?: string) => {
    try {
      const body: Record<string, string> = {}
      if (sessionId) body.sessionId = sessionId
      if (cwd) body.cwd = cwd
      const res = await fetch('/sessions/start', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = await res.json()
        console.error('Failed to start session:', data.error)
      }
      // View switch happens when bridge broadcasts session_status: running
    } catch (err) {
      console.error('Failed to start session:', err)
    }
  }, [])

  // Build the streaming ChatMessage to display at the bottom
  const streamingChatMsg: ChatMessage | null = streamingMsg
    ? {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: streamingToContent(streamingMsg),
        },
        _streaming: true,
      }
    : null

  // T-34: Connection status indicator colors and labels
  const statusColor = status === 'connected' ? 'bg-green-400'
    : status === 'reconnecting' ? 'bg-yellow-400 animate-pulse'
    : status === 'connecting' ? 'bg-yellow-400 animate-pulse'
    : 'bg-red-400'

  const statusLabel = status === 'connected' ? 'Connected'
    : status === 'reconnecting' && reconnectInfo
      ? `Reconnecting (${reconnectInfo.attempt}/${reconnectInfo.maxAttempts})`
    : status === 'connecting' ? 'Connecting...'
    : 'Disconnected'

  return (
    <div className="h-dvh bg-white dark:bg-gray-900 text-gray-900 dark:text-white flex flex-col">
      {/* Header */}
      <header className="p-4 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2 shrink-0">
        <span className={`w-2 h-2 rounded-full ${statusColor}`} />
        <span className="font-mono text-sm">{statusLabel}</span>
        {status === 'disconnected' && (
          <button
            onClick={() => {
              // Reset stale UI state from previous session
              setStreamingMsg(null)
              setPendingPerms(new Map())
              streamStateRef.current.reset()
              wsRef.current?.reconnect()
            }}
            className="ml-1 px-2 py-0.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors"
          >
            Reconnect
          </button>
        )}
        {/* B-06: Theme toggle */}
        <button
          onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
          className="ml-auto p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors text-lg"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19'}
        </button>
        <span className="text-xs text-gray-500">remote-cc v0.1.0</span>
      </header>

      {/* T-34: Reconnecting banner */}
      {status === 'reconnecting' && (
        <div className="px-4 py-2 bg-yellow-900/80 text-yellow-200 text-sm text-center shrink-0">
          Connection lost. Reconnecting{reconnectInfo ? ` (${reconnectInfo.attempt}/${reconnectInfo.maxAttempts})` : ''}...
        </div>
      )}

      {/* T-34: Reconnected banner — auto-dismisses after 3s */}
      {showReconnected && status === 'connected' && (
        <div className="px-4 py-2 bg-green-900/80 text-green-200 text-sm text-center shrink-0">
          Reconnected
        </div>
      )}

      {/* View routing — cluster mode: dashboard → machineSessions → chat;
          standalone: picker → chat */}
      {view === 'dashboard' ? (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="px-4 pt-4 sm:px-6 flex justify-end shrink-0">
            <button
              onClick={() => setShowQuickTask(true)}
              className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors"
              aria-label="Open quick task modal"
            >
              ⚡ Quick Task
            </button>
          </div>
          <MachineDashboard
            onOpenMachine={(m) => {
              setTargetMachine(m)
              setView('machineSessions')
            }}
            onStartMachine={(m) => {
              // Start a new session on this machine via cluster proxy
              setTargetMachine(m)
              startClusterSession(m.machineId).catch(console.error)
            }}
            onMachinesLoaded={setDashboardMachines}
          />
        </div>
      ) : view === 'machineSessions' ? (
        <GlobalSessionList
          machineFilter={targetMachine?.machineId}
          onSelect={(s) => {
            startClusterSession(s.machineId, s.id).catch(console.error)
          }}
          onNew={(machineId) => {
            startClusterSession(machineId).catch(console.error)
          }}
        />
      ) : view === 'picker' ? (
        <SessionPicker
          onSelect={(id, cwd) => startSession(id, cwd)}
          onNew={() => startSession()}
        />
      ) : (
        <>
          {/* Messages */}
          <main className="flex-1 overflow-y-auto px-2 py-4 sm:px-4">
            {messages.length === 0 && !streamingChatMsg && (
              <p className="text-gray-500 text-center mt-20">Send a message to get started</p>
            )}
            {messages.map((msg, i) => (
              <MessageRenderer key={i} msg={msg} onAnswerQuestion={handleAnswerQuestion} />
            ))}
            {streamingChatMsg && (
              <MessageRenderer msg={streamingChatMsg} onAnswerQuestion={handleAnswerQuestion} />
            )}
            {/* T-M16: inline in-flight tool indicators */}
            {Array.from(toolProgress.entries()).map(([id, p]) => (
              <ProgressIndicator key={id} toolName={p.toolName} elapsedSeconds={p.elapsedSeconds} />
            ))}
            <div ref={bottomRef} />
          </main>

          {/* Input */}
          <footer className="px-2 py-2 sm:px-4 sm:py-4 border-t border-gray-200 dark:border-gray-700 shrink-0 pb-[env(safe-area-inset-bottom,8px)]">
            {/* T-36: Quick command panel — mobile only */}
            <QuickCommands
              onCommand={async (cmd) => {
                if (!wsRef.current || status !== 'connected') return
                // Route QuickCommand taps through the slash-command parser
                // so /clear, /cost, /model, /compact, /help all behave the
                // same as typing the command. Without this, the chip just
                // sends "/clear" as a raw user message to Claude — which
                // either replies with its own /clear semantics (wrong) or
                // treats it as literal text.
                const slash = parseSlashCommand(cmd)
                if (slash.handled) {
                  if (slash.kind === 'clear') {
                    setMessages([])
                    setStreamingMsg(null)
                    setPendingPerms(new Map())
                    streamStateRef.current.reset()
                    if (slash.confirm) {
                      setMessages([{ type: 'system', subtype: 'status', text: slash.confirm } as unknown as ChatMessage])
                    }
                    return
                  }
                  if (slash.kind === 'cost') {
                    setShowCostOverlay(true)
                    return
                  }
                  if (slash.kind === 'noop') {
                    setMessages((prev) => [...prev, { type: 'system', subtype: 'status', text: slash.feedback } as unknown as ChatMessage])
                    return
                  }
                  if (slash.kind === 'send_control') {
                    await wsRef.current.send(slash.controlMsg)
                    return
                  }
                }
                const msg: ChatMessage = {
                  type: 'user',
                  message: { role: 'user', content: cmd },
                  parent_tool_use_id: null,
                  session_id: '',
                }
                const ok = await wsRef.current.send(msg)
                if (!ok) console.error('Failed to send quick command')
              }}
            />
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onCompositionStart={() => { isComposingRef.current = true }}
                onCompositionEnd={() => { isComposingRef.current = false }}
                placeholder={status === 'connected' ? 'Type a message...' : 'Waiting for connection...'}
                disabled={status !== 'connected'}
                className="flex-1 bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white p-3 rounded-lg outline-none
                  focus:ring-2 focus:ring-blue-500 min-h-[44px] text-base
                  disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <button
                onClick={sendMessage}
                disabled={status !== 'connected' || !input.trim()}
                className="px-4 py-3 bg-blue-600 rounded-lg font-medium text-sm min-h-[44px]
                  hover:bg-blue-500 transition-colors
                  disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Send
              </button>
            </div>
          </footer>
        </>
      )}

      {/* T-19: Permission dialog — show first pending request */}
      {pendingPerms.size > 0 && (() => {
        const first = pendingPerms.values().next().value as PermissionRequest
        return <PermissionDialog request={first} onRespond={handlePermission} />
      })()}

      {/* T-M26: Quick Task modal */}
      {showQuickTask && (
        <QuickTask
          machines={dashboardMachines}
          defaultMachineId={targetMachine?.machineId}
          onClose={() => setShowQuickTask(false)}
          onSubmitted={(machineId) => {
            const m = dashboardMachines.find((x) => x.machineId === machineId)
            if (m) {
              setTargetMachine(m)
              setView('chat')
            }
          }}
        />
      )}

      {/* T-M18: /cost overlay — cumulative usage summary */}
      {showCostOverlay && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40"
          onClick={() => setShowCostOverlay(false)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-t-2xl sm:rounded-2xl p-5 max-w-md w-full m-2 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold mb-3">Cumulative usage</h3>
            <dl className="grid grid-cols-2 gap-y-1 text-sm">
              <dt className="text-gray-500">Turns</dt>
              <dd className="font-mono">{cumulativeUsage.turnCount}</dd>
              <dt className="text-gray-500">Input tokens</dt>
              <dd className="font-mono">{cumulativeUsage.inputTokens.toLocaleString()}</dd>
              <dt className="text-gray-500">Output tokens</dt>
              <dd className="font-mono">{cumulativeUsage.outputTokens.toLocaleString()}</dd>
              <dt className="text-gray-500">Total cost</dt>
              <dd className="font-mono">${cumulativeUsage.totalCostUsd.toFixed(4)}</dd>
            </dl>
            <button
              onClick={() => setShowCostOverlay(false)}
              className="mt-4 w-full px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-500 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* T-28: PWA install prompt */}
      <InstallPrompt />
    </div>
  )
}
