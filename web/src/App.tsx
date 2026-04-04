// T-10/T-13/T-14/T-19-21/T-32-34: Chat interface with streaming, permission approval, reconnect for remote-cc web UI

import { useState, useEffect, useRef, useCallback } from 'react'
import { connectWs, type WsState, type ReconnectMeta } from './ws'
import MessageRenderer, { type ChatMessage } from './MessageRenderer'
import { createStreamingState, streamingToContent, type StreamingMessage } from './streamingState'
import PermissionDialog, { type PermissionRequest, type PermissionAction } from './PermissionDialog'
import InstallPrompt from './InstallPrompt'
import QuickCommands from './QuickCommands'

function getWsUrl(): string {
  const params = new URLSearchParams(window.location.search)
  // Infer WS URL from current page location (same host:port, ws:// protocol)
  const loc = window.location
  const wsProtocol = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  const defaultWs = `${wsProtocol}//${loc.host}`
  const base = params.get('ws') ?? defaultWs
  // Pass the auth token from page URL to WebSocket URL as a query parameter,
  // since browser WebSocket cannot set custom headers.
  const token = params.get('token')
  if (token) {
    const sep = base.includes('?') ? '&' : '?'
    return `${base}${sep}token=${encodeURIComponent(token)}`
  }
  return base
}

export default function App() {
  const [status, setStatus] = useState<WsState>('disconnected')
  // T-34: Track reconnect attempt for UI display
  const [reconnectInfo, setReconnectInfo] = useState<ReconnectMeta | null>(null)
  // T-34: "Reconnected" banner that auto-dismisses after 3s
  const [showReconnected, setShowReconnected] = useState(false)
  const reconnectedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevStatusRef = useRef<WsState>('disconnected')

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamingMsg, setStreamingMsg] = useState<StreamingMessage | null>(null)
  const [input, setInput] = useState('')
  // T-19: Pending permission requests (Map<request_id, PermissionRequest>)
  const [pendingPerms, setPendingPerms] = useState<Map<string, PermissionRequest>>(new Map())
  const bottomRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<ReturnType<typeof connectWs> | null>(null)
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

  // Connect WebSocket on mount
  useEffect(() => {
    const ws = connectWs(getWsUrl())
    wsRef.current = ws
    const ss = streamStateRef.current

    // T-34: Handle state changes with reconnect metadata
    ws.onStateChange((state: WsState, meta?: ReconnectMeta) => {
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

    ws.onMessage((data) => {
      if (!data || typeof data !== 'object' || !('type' in (data as Record<string, unknown>))) return

      const d = data as Record<string, unknown>

      // T-13: Route partial messages through streaming state machine
      if (d.type === 'assistant' && d.subtype === 'partial') {
        const event = d.event as Record<string, unknown> | undefined

        // message_stop: finalize streaming → move to regular messages
        if (event?.type === 'message_stop') {
          ss.handlePartial(data)
          const final = ss.finalize()
          if (final) {
            // Flush any pending rAF
            if (rafIdRef.current) {
              cancelAnimationFrame(rafIdRef.current)
              rafIdRef.current = null
            }
            pendingUpdateRef.current = null
            setStreamingMsg(null)

            // Convert to ChatMessage format and add to messages
            const chatMsg: ChatMessage = {
              type: 'assistant',
              message: {
                role: 'assistant',
                content: streamingToContent(final),
              },
            }
            setMessages((prev) => [...prev, chatMsg])
          }
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

      // Filter: only show user-visible system messages
      if (d.type === 'system') {
        const sub = (d as Record<string, unknown>).subtype as string
        // Skip technical messages (init, hooks, compact boundaries)
        const skipSubtypes = new Set([
          'init', 'hook_started', 'hook_response', 'hook_progress',
          'compact_boundary', 'microcompact_boundary',
        ])
        if (!skipSubtypes.has(sub)) {
          setMessages((prev) => [...prev, data as ChatMessage])
        }
        return
      }

      // Result message: show as status, not raw JSON
      if (d.type === 'result') {
        const result = d as Record<string, unknown>
        const text = (result.result as string) || (result.subtype === 'success' ? 'Completed' : 'Error')
        setMessages((prev) => [...prev, {
          type: 'system',
          subtype: 'status',
          text,
          _original: data,
        } as unknown as ChatMessage])
        return
      }
    })

    return () => {
      ws.close()
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

  const sendMessage = useCallback(() => {
    const text = input.trim()
    if (!text || !wsRef.current) return

    const msg: ChatMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    }

    // Show locally immediately
    setMessages((prev) => [...prev, msg])

    // Send SDKUserMessage over WebSocket
    wsRef.current.send(msg)
    setInput('')
  }, [input])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  // T-20: Send control_response and remove from pending
  const handlePermission = useCallback((action: PermissionAction) => {
    if (!wsRef.current) return

    if (action.behavior === 'allow') {
      wsRef.current.send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: action.requestId,
          response: { behavior: 'allow', updatedInput: null },
        },
      })
    } else {
      wsRef.current.send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: action.requestId,
          response: { behavior: 'deny', message: 'User denied this operation' },
        },
      })
    }

    setPendingPerms((prev) => {
      const next = new Map(prev)
      next.delete(action.requestId)
      return next
    })
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
    <div className="h-dvh bg-gray-900 text-white flex flex-col">
      {/* Header */}
      <header className="p-4 border-b border-gray-700 flex items-center gap-2 shrink-0">
        <span className={`w-2 h-2 rounded-full ${statusColor}`} />
        <span className="font-mono text-sm">{statusLabel}</span>
        <span className="ml-auto text-xs text-gray-500">remote-cc v0.1.0</span>
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
      <footer className="px-2 py-2 sm:px-4 sm:py-4 border-t border-gray-700 shrink-0 pb-[env(safe-area-inset-bottom,8px)]">
        {/* T-36: Quick command panel — mobile only */}
        <QuickCommands
          onCommand={(cmd) => {
            if (!wsRef.current || status !== 'connected') return
            const msg: ChatMessage = {
              type: 'user',
              message: { role: 'user', content: cmd },
              parent_tool_use_id: null,
              session_id: '',
            }
            setMessages((prev) => [...prev, msg])
            wsRef.current.send(msg)
          }}
        />
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={status === 'connected' ? 'Type a message...' : 'Waiting for connection...'}
            disabled={status !== 'connected'}
            className="flex-1 bg-gray-800 text-white p-3 rounded-lg outline-none
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
