// T-10: Chat interface for remote-cc web UI

import { useState, useEffect, useRef, useCallback } from 'react'
import { connectWs } from './ws'
import MessageRenderer, { type ChatMessage } from './MessageRenderer'

function getWsUrl(): string {
  const params = new URLSearchParams(window.location.search)
  return params.get('ws') ?? 'ws://localhost:7860'
}

export default function App() {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<ReturnType<typeof connectWs> | null>(null)

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Connect WebSocket on mount
  useEffect(() => {
    const ws = connectWs(getWsUrl())
    wsRef.current = ws

    ws.onStateChange(setStatus)

    ws.onMessage((data) => {
      if (data && typeof data === 'object' && 'type' in (data as Record<string, unknown>)) {
        const msg = data as ChatMessage
        // Fix 2: Only display chat messages, skip keep_alive/control signals
        const chatTypes = new Set(['assistant', 'system', 'result'])
        if (!chatTypes.has(msg.type)) return
        // Fix 3: Skip incoming 'user' messages — we already echo them locally
        // (handles --replay-user-messages duplication)
        setMessages((prev) => [...prev, msg])
      }
    })

    return () => ws.close()
  }, [])

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
        {messages.length === 0 && (
          <p className="text-gray-500 text-center mt-20">Send a message to get started</p>
        )}
        {messages.map((msg, i) => (
          <MessageRenderer key={i} msg={msg} />
        ))}
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
    </div>
  )
}
