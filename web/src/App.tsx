// T-10/T-13/T-14/T-19-21/T-32-34/T-F10/T-S08: Chat interface with streaming, permission approval, reconnect, session picker for remote-cc web UI

import { useState, useEffect, useRef, useCallback } from 'react'
import { connectTransport, type TransportState, type ReconnectMeta } from './transport'
import MessageRenderer, { type ChatMessage } from './MessageRenderer'
import { createStreamingState, streamingToContent, type StreamingMessage } from './streamingState'
import PermissionDialog, { type PermissionRequest, type PermissionAction } from './PermissionDialog'
import InstallPrompt from './InstallPrompt'
import QuickCommands from './QuickCommands'
import SessionPicker from './SessionPicker'
import MachineDashboard, { type ClusterMachine } from './MachineDashboard'
import GlobalSessionList, { type GlobalSessionInfo } from './GlobalSessionList'
import { getClusterToken, getClusterHeaders } from './authUtils'

/** System subtypes that are internal/technical — never shown in chat */
const SKIP_SUBTYPES = new Set([
  'init', 'hook_started', 'hook_response', 'hook_progress',
  'compact_boundary', 'microcompact_boundary',
  'task_started', 'task_progress', 'task_notification',
  'session_state_changed', 'files_persisted',
  'status', 'api_retry', 'rate_limit', 'rate_limit_event',
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

  // Connect SSE transport on mount
  useEffect(() => {
    const transport = connectTransport(getTransportUrl())
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

      // Result message: skip — assistant message already contains the reply.
      // Only show result if it's an error.
      if (d.type === 'result') {
        const result = d as Record<string, unknown>
        if (result.is_error || result.subtype === 'error') {
          setMessages((prev) => [...prev, {
            type: 'system',
            subtype: 'status',
            text: `Error: ${(result.result as string) || 'Unknown error'}`,
            _original: data,
          } as unknown as ChatMessage])
        }
        return
      }
    })

    return () => {
      transport.close()
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
  }, [scheduleRender])

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || !wsRef.current) return

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

  // Cluster mode: start/resume a session on a target machine via /cluster/action.
  // The bridge's heartbeat will flip status to "running" → UI transitions to chat.
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
      // For now, jump directly to chat view. Real transport wiring to the
      // target machine's SSE (via proxy) is handled by a follow-up task —
      // this gives the user feedback that the request was accepted.
      setView('chat')
    } catch (err) {
      console.error('Cluster start_session error:', err)
    }
  }, [])

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
        />
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
              <MessageRenderer key={i} msg={msg} />
            ))}
            {streamingChatMsg && (
              <MessageRenderer msg={streamingChatMsg} />
            )}
            <div ref={bottomRef} />
          </main>

          {/* Input */}
          <footer className="px-2 py-2 sm:px-4 sm:py-4 border-t border-gray-200 dark:border-gray-700 shrink-0 pb-[env(safe-area-inset-bottom,8px)]">
            {/* T-36: Quick command panel — mobile only */}
            <QuickCommands
              onCommand={async (cmd) => {
                if (!wsRef.current || status !== 'connected') return
                const msg: ChatMessage = {
                  type: 'user',
                  message: { role: 'user', content: cmd },
                  parent_tool_use_id: null,
                  session_id: '',
                }
                // B-01: No local echo — let server replay add the message
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

      {/* T-28: PWA install prompt */}
      <InstallPrompt />
    </div>
  )
}
