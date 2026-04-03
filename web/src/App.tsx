// T-10/T-13/T-14/T-19-21: Chat interface with streaming + permission approval for remote-cc web UI

import { useState, useEffect, useRef, useCallback } from 'react'
import { connectWs } from './ws'
import MessageRenderer, { type ChatMessage } from './MessageRenderer'
import { createStreamingState, streamingToContent, type StreamingMessage } from './streamingState'
import PermissionDialog, { type PermissionRequest, type PermissionAction } from './PermissionDialog'

function getWsUrl(): string {
  const params = new URLSearchParams(window.location.search)
  return params.get('ws') ?? 'ws://localhost:7860'
}

export default function App() {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected')
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

    ws.onStateChange(setStatus)

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

      // Other chat message types
      const chatTypes = new Set(['system', 'result'])
      if (chatTypes.has(d.type as string)) {
        setMessages((prev) => [...prev, data as ChatMessage])
      }
    })

    return () => {
      ws.close()
      // Clean up rAF on unmount
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
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

  const statusColor = status === 'connected' ? 'bg-green-400'
    : status === 'connecting' ? 'bg-yellow-400 animate-pulse'
    : 'bg-red-400'

  const statusLabel = status === 'connected' ? 'Connected'
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

      {/* Messages */}
      <main className="flex-1 overflow-y-auto p-4">
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
      <footer className="p-4 border-t border-gray-700 shrink-0">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={status === 'connected' ? 'Type a message...' : 'Waiting for connection...'}
            disabled={status !== 'connected'}
            className="flex-1 bg-gray-800 text-white p-3 rounded-lg outline-none
              focus:ring-2 focus:ring-blue-500
              disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <button
            onClick={sendMessage}
            disabled={status !== 'connected' || !input.trim()}
            className="px-4 py-3 bg-blue-600 rounded-lg font-medium text-sm
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
    </div>
  )
}
