// T-S07: SSE + POST transport client for remote-cc web UI
// Replaces ws.ts: EventSource for receiving, fetch POST for sending.

export type TransportState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

export interface ReconnectMeta {
  attempt: number
  maxAttempts: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Consecutive onerror count before we abandon native EventSource reconnect. */
const MAX_NATIVE_ERRORS = 5

/** Total time budget (ms) before giving up entirely. */
const GIVE_UP_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

/** Manual reconnect backoff base (ms). */
const BACKOFF_BASE_MS = 1000

/** Manual reconnect backoff ceiling (ms). */
const BACKOFF_MAX_MS = 30_000

/** If no data/keepalive received for this long, force reconnect. */
const LIVENESS_TIMEOUT_MS = 45_000

/** Max send retries per message. */
const SEND_RETRIES = 2

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function backoffWithJitter(attempt: number): number {
  const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt - 1), BACKOFF_MAX_MS)
  const jitter = delay * 0.25 * (Math.random() * 2 - 1) // ±25%
  return Math.max(0, delay + jitter)
}

// ---------------------------------------------------------------------------
// connectTransport
// ---------------------------------------------------------------------------

export function connectTransport(baseHttpUrl: string) {
  // --- Parse origin + token from the provided URL ---
  const url = new URL(baseHttpUrl)
  const origin = url.origin
  const token = url.searchParams.get('token') ?? ''

  // --- State ---
  type MessageCallback = (data: unknown) => void
  type StateCallback = (state: TransportState, meta?: ReconnectMeta) => void

  const messageCallbacks: MessageCallback[] = []
  const stateCallbacks: StateCallback[] = []
  let currentState: TransportState = 'connecting'
  let es: EventSource | null = null
  let lastSeq = 0
  let closed = false

  // Reconnect tracking
  let consecutiveErrors = 0
  let manualAttempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let startTime = Date.now()

  // Liveness timer
  let livenessTimer: ReturnType<typeof setTimeout> | null = null

  // -------------------------------------------------------------------------
  // Notify helpers
  // -------------------------------------------------------------------------

  function setState(state: TransportState, meta?: ReconnectMeta) {
    currentState = state
    for (const cb of stateCallbacks) {
      try { cb(state, meta) } catch { /* swallow listener errors */ }
    }
  }

  function fireMessage(data: unknown) {
    for (const cb of messageCallbacks) {
      try { cb(data) } catch { /* swallow listener errors */ }
    }
  }

  // -------------------------------------------------------------------------
  // Liveness timer
  // -------------------------------------------------------------------------

  function resetLiveness() {
    if (livenessTimer) clearTimeout(livenessTimer)
    if (closed) return
    livenessTimer = setTimeout(() => {
      // No data for LIVENESS_TIMEOUT_MS → force reconnect
      if (es) {
        es.close()
        es = null
      }
      manualReconnect()
    }, LIVENESS_TIMEOUT_MS)
  }

  function stopLiveness() {
    if (livenessTimer) {
      clearTimeout(livenessTimer)
      livenessTimer = null
    }
  }

  // -------------------------------------------------------------------------
  // EventSource setup
  // -------------------------------------------------------------------------

  function buildSseUrl(): string {
    const sseUrl = new URL('/events/stream', origin)
    if (token) sseUrl.searchParams.set('token', token)
    if (lastSeq > 0) sseUrl.searchParams.set('from_seq', String(lastSeq))
    return sseUrl.toString()
  }

  function openEventSource() {
    if (closed) return

    setState('connecting')
    es = new EventSource(buildSseUrl())

    // --- onopen: connected ---
    es.onopen = () => {
      consecutiveErrors = 0
      manualAttempts = 0
      startTime = Date.now() // reset give-up timer on successful connection
      setState('connected')
      resetLiveness()
    }

    // --- onerror: track consecutive failures ---
    es.onerror = () => {
      if (closed) return

      consecutiveErrors++

      // While EventSource auto-reconnects, show reconnecting state
      if (currentState !== 'reconnecting' && currentState !== 'disconnected') {
        setState('reconnecting', {
          attempt: consecutiveErrors,
          maxAttempts: MAX_NATIVE_ERRORS,
        })
      }

      // After too many consecutive errors, abandon native reconnect
      if (consecutiveErrors >= MAX_NATIVE_ERRORS) {
        if (es) {
          es.close()
          es = null
        }
        manualReconnect()
      }
    }

    // --- message event: claude output ---
    es.addEventListener('message', (event: MessageEvent) => {
      consecutiveErrors = 0
      resetLiveness()

      // Update lastSeq from SSE id field
      if (event.lastEventId) {
        const seq = parseInt(event.lastEventId, 10)
        if (!isNaN(seq)) lastSeq = seq
      }

      let data: unknown
      try {
        data = JSON.parse(event.data)
      } catch {
        data = event.data
      }
      fireMessage(data)
    })

    // --- session_status event ---
    es.addEventListener('session_status', (event: MessageEvent) => {
      consecutiveErrors = 0
      resetLiveness()

      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(event.data) as Record<string, unknown>
      } catch {
        return // malformed, skip
      }

      // Reset lastSeq when session ends (new session starts from 0)
      if (parsed.state === 'session_ended') {
        lastSeq = 0
      }

      // Translate to original ws.ts format for App.tsx compatibility
      fireMessage({ type: 'system', subtype: 'session_status', ...parsed })
    })

    // --- keepalive event (sent as event:keepalive by bridge) ---
    es.addEventListener('keepalive', () => {
      resetLiveness()
    })
  }

  // -------------------------------------------------------------------------
  // Manual reconnect with backoff
  // -------------------------------------------------------------------------

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function manualReconnect() {
    if (closed) return

    // Check give-up timeout
    if (Date.now() - startTime >= GIVE_UP_TIMEOUT_MS) {
      setState('disconnected')
      stopLiveness()
      return
    }

    manualAttempts++
    const delay = backoffWithJitter(manualAttempts)

    setState('reconnecting', {
      attempt: manualAttempts,
      maxAttempts: Math.ceil(GIVE_UP_TIMEOUT_MS / BACKOFF_BASE_MS), // approximate
    })

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      consecutiveErrors = 0
      openEventSource()
    }, delay)
  }

  // -------------------------------------------------------------------------
  // Online/offline listener
  // -------------------------------------------------------------------------

  function handleOnline() {
    if (closed) return
    // Network came back — reset and reconnect immediately
    clearReconnectTimer()
    if (es) {
      es.close()
      es = null
    }
    consecutiveErrors = 0
    manualAttempts = 0
    startTime = Date.now()
    openEventSource()
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline)
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  openEventSource()

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    async send(msg: unknown): Promise<boolean> {
      const messageId = crypto.randomUUID()
      const body = typeof msg === 'object' && msg !== null
        ? { ...msg, _messageId: messageId }
        : { payload: msg, _messageId: messageId }

      const postUrl = `${origin}/messages`
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }

      for (let attempt = 0; attempt < SEND_RETRIES; attempt++) {
        try {
          const res = await fetch(postUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          })
          if (res.ok) return true
          if (res.status === 401 || res.status === 400) return false
        } catch {
          // Network error — retry after delay
        }
        // Wait 500ms before retry (gives transient failures time to resolve)
        if (attempt < SEND_RETRIES - 1) {
          await new Promise(r => setTimeout(r, 500))
        }
      }
      return false
    },

    onMessage(cb: MessageCallback) {
      messageCallbacks.push(cb)
    },

    onStateChange(cb: StateCallback) {
      stateCallbacks.push(cb)
      // Immediately fire current state (same as ws.ts contract)
      try {
        if (currentState === 'reconnecting') {
          cb(currentState, {
            attempt: manualAttempts || consecutiveErrors,
            maxAttempts: MAX_NATIVE_ERRORS,
          })
        } else {
          cb(currentState)
        }
      } catch { /* swallow */ }
    },

    reconnect() {
      clearReconnectTimer()
      stopLiveness()
      consecutiveErrors = 0
      manualAttempts = 0
      startTime = Date.now()
      if (es) {
        es.close()
        es = null
      }
      openEventSource()
    },

    close() {
      closed = true
      clearReconnectTimer()
      stopLiveness()
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline)
      }
      if (es) {
        es.close()
        es = null
      }
      setState('disconnected')
    },

    getLastSeq(): number {
      return lastSeq
    },
  }
}
