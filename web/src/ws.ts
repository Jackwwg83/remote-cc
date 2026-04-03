// T-09: WebSocket client for remote-cc web UI

type WsState = 'connecting' | 'connected' | 'disconnected'
type MessageCallback = (data: unknown) => void
type StateCallback = (state: WsState) => void
type ErrorCallback = (err: Event) => void

export function connectWs(url: string) {
  const messageCallbacks: MessageCallback[] = []
  const stateCallbacks: StateCallback[] = []
  const errorCallbacks: ErrorCallback[] = []
  let ws: WebSocket | null = null

  function notify(state: WsState) {
    for (const cb of stateCallbacks) {
      try { cb(state) } catch { /* swallow listener errors */ }
    }
  }

  function open() {
    notify('connecting')
    ws = new WebSocket(url)

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
      let data: unknown
      try {
        data = JSON.parse(ev.data as string)
      } catch {
        // Non-JSON message — pass raw string
        data = ev.data
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

    close() {
      if (ws) {
        ws.onclose = null  // prevent state notification on intentional close
        ws.close()
        ws = null
        notify('disconnected')
      }
    },
  }
}
