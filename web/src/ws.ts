// T-09/T-32/T-33: WebSocket client for remote-cc web UI
// Supports seq envelope unwrapping, last_seq reconnect replay, and auto-reconnect.

export type WsState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
type MessageCallback = (data: unknown) => void
type StateCallback = (state: WsState, meta?: ReconnectMeta) => void
type ErrorCallback = (err: Event) => void

/** Metadata passed with 'reconnecting' state changes */
export interface ReconnectMeta {
  attempt: number
  maxAttempts: number
}

/** Seq envelope sent by the bridge: {"seq": N, "data": "<original JSON>"} */
interface SeqEnvelope {
  seq: number
  data: string
}

function isSeqEnvelope(obj: unknown): obj is SeqEnvelope {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'seq' in obj &&
    'data' in obj &&
    typeof (obj as SeqEnvelope).seq === 'number' &&
    typeof (obj as SeqEnvelope).data === 'string'
  )
}

// T-32: Reconnect constants (matches reference: RECONNECT_DELAY_MS=2000, MAX_RECONNECT_ATTEMPTS=5)
const RECONNECT_DELAY_MS = 2000
const MAX_RECONNECT_ATTEMPTS = 5

/** Close codes that should NOT trigger reconnect */
const NO_RECONNECT_CODES = new Set([
  1000, // normal close
  4003, // unauthorized
])

export function connectWs(baseUrl: string) {
  const messageCallbacks: MessageCallback[] = []
  const stateCallbacks: StateCallback[] = []
  const errorCallbacks: ErrorCallback[] = []
  let ws: WebSocket | null = null
  let lastSeq = 0
  let intentionalClose = false

  // T-32: Reconnect state
  let reconnectAttempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let wasConnected = false  // track if we ever established a connection

  function notify(state: WsState, meta?: ReconnectMeta) {
    for (const cb of stateCallbacks) {
      try { cb(state, meta) } catch { /* swallow listener errors */ }
    }
  }

  /** Build the WS URL, appending last_seq for reconnect replay (T-33). */
  function buildUrl(): string {
    if (lastSeq === 0) return baseUrl
    const sep = baseUrl.includes('?') ? '&' : '?'
    return `${baseUrl}${sep}last_seq=${lastSeq}`
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  /** T-32: Schedule a reconnect with exponential backoff: 2s, 4s, 8s, 16s, 32s */
  function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      notify('disconnected')
      return
    }

    reconnectAttempts++
    const delay = RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1)

    notify('reconnecting', {
      attempt: reconnectAttempts,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
    })

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      open()
    }, delay)
  }

  function open() {
    intentionalClose = false
    notify('connecting')
    ws = new WebSocket(buildUrl())

    ws.onopen = () => {
      // T-32: Reset backoff on successful connection
      const wasReconnect = reconnectAttempts > 0
      reconnectAttempts = 0
      wasConnected = true
      notify('connected')

      // If this was a reconnect, the bridge will replay missed messages via last_seq (T-33).
      // The caller can detect this via the wasReconnect info if needed.
      if (wasReconnect && lastSeq > 0) {
        // Replay is handled by the bridge — messages will arrive via onmessage.
        // Duplicates are skipped because the bridge only sends seq > last_seq.
      }
    }

    ws.onclose = (ev: CloseEvent) => {
      ws = null
      const code = ev.code

      // Don't reconnect on intentional close
      if (intentionalClose) {
        notify('disconnected')
        return
      }

      // T-32: Don't reconnect on permanent close codes (4003 unauthorized, 1000 normal)
      if (NO_RECONNECT_CODES.has(code)) {
        notify('disconnected')
        return
      }

      // T-32: Auto-reconnect with backoff if we were previously connected
      // or if the initial connection failed (network error)
      if (wasConnected || reconnectAttempts > 0) {
        scheduleReconnect()
      } else {
        // First connection failed — still try to reconnect
        scheduleReconnect()
      }
    }

    ws.onerror = (ev: Event) => {
      // Surface the error to listeners
      for (const cb of errorCallbacks) {
        try { cb(ev) } catch { /* swallow listener errors */ }
      }
      // onerror always fires before onclose; onclose handles state + reconnect
    }

    ws.onmessage = (ev: MessageEvent) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(ev.data as string)
      } catch {
        // Non-JSON message — pass raw string
        parsed = ev.data
      }

      // Unwrap seq envelope if present
      let data: unknown
      if (isSeqEnvelope(parsed)) {
        lastSeq = parsed.seq
        try {
          data = JSON.parse(parsed.data)
        } catch {
          data = parsed.data
        }
      } else {
        // Legacy or non-enveloped message — pass through as-is
        data = parsed
      }

      for (const cb of messageCallbacks) {
        try { cb(data) } catch { /* swallow listener errors */ }
      }
    }
  }

  // T-32: Listen to navigator.onLine — trigger reconnect when back online
  function handleOnline() {
    // If we're disconnected or reconnecting, try immediately
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      clearReconnectTimer()
      reconnectAttempts = 0  // reset backoff since network just came back
      open()
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline)
  }

  open()

  return {
    send(msg: unknown) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg))
      }
    },

    onMessage(cb: MessageCallback) {
      messageCallbacks.push(cb)
    },

    onError(cb: ErrorCallback) {
      errorCallbacks.push(cb)
    },

    onStateChange(cb: StateCallback) {
      stateCallbacks.push(cb)
      // Immediately fire current state so caller doesn't miss it
      if (ws) {
        const s = ws.readyState
        if (s === WebSocket.CONNECTING) cb('connecting')
        else if (s === WebSocket.OPEN) cb('connected')
        else if (reconnectAttempts > 0) {
          cb('reconnecting', {
            attempt: reconnectAttempts,
            maxAttempts: MAX_RECONNECT_ATTEMPTS,
          })
        } else {
          cb('disconnected')
        }
      } else if (reconnectAttempts > 0) {
        cb('reconnecting', {
          attempt: reconnectAttempts,
          maxAttempts: MAX_RECONNECT_ATTEMPTS,
        })
      } else {
        cb('disconnected')
      }
    },

    /** Reconnect with last_seq for replay of missed messages. */
    reconnect() {
      clearReconnectTimer()
      reconnectAttempts = 0
      if (ws) {
        // Fully detach old socket to prevent late events
        ws.onopen = null
        ws.onclose = null
        ws.onmessage = null
        ws.onerror = null
        ws.close()
        ws = null
      }
      open()
    },

    close() {
      intentionalClose = true
      clearReconnectTimer()
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline)
      }
      if (ws) {
        ws.onclose = null  // prevent state notification on intentional close
        ws.close()
        ws = null
        notify('disconnected')
      }
    },

    /** Return the last received sequence number. */
    getLastSeq() {
      return lastSeq
    },
  }
}
