// T-09: WebSocket client for remote-cc web UI
// Supports seq envelope unwrapping and last_seq reconnect replay.

type WsState = 'connecting' | 'connected' | 'disconnected'
type MessageCallback = (data: unknown) => void
type StateCallback = (state: WsState) => void
type ErrorCallback = (err: Event) => void

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

export function connectWs(baseUrl: string) {
  const messageCallbacks: MessageCallback[] = []
  const stateCallbacks: StateCallback[] = []
  const errorCallbacks: ErrorCallback[] = []
  let ws: WebSocket | null = null
  let lastSeq = 0
  let intentionalClose = false

  function notify(state: WsState) {
    for (const cb of stateCallbacks) {
      try { cb(state) } catch { /* swallow listener errors */ }
    }
  }

  /** Build the WS URL, appending last_seq for reconnect replay. */
  function buildUrl(): string {
    if (lastSeq === 0) return baseUrl
    const sep = baseUrl.includes('?') ? '&' : '?'
    return `${baseUrl}${sep}last_seq=${lastSeq}`
  }

  function open() {
    intentionalClose = false
    notify('connecting')
    ws = new WebSocket(buildUrl())

    ws.onopen = () => notify('connected')

    ws.onclose = () => {
      ws = null
      notify('disconnected')
    }

    ws.onerror = (ev: Event) => {
      // Surface the error to listeners
      for (const cb of errorCallbacks) {
        try { cb(ev) } catch { /* swallow listener errors */ }
      }
      // onerror always fires before onclose; onclose handles state
      notify('disconnected')
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
        else cb('disconnected')
      } else {
        cb('disconnected')
      }
    },

    /** Reconnect with last_seq for replay of missed messages. */
    reconnect() {
      if (ws) {
        ws.onclose = null
        ws.close()
        ws = null
      }
      open()
    },

    close() {
      intentionalClose = true
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
