/**
 * machineTransport.ts — Multi-machine transport with direct → proxy fallback.
 *
 * Wraps connectTransport() so the UI can target a specific machine across the
 * cluster. Tries a direct connection first (best latency, no server proxy
 * load); if the direct path stays unhealthy (repeated reconnect failures or
 * "disconnected" final state), falls back to routing through the cluster
 * server's /cluster/stream + /cluster/message proxy endpoints.
 *
 * Design:
 *   - Single facade that mimics the connectTransport() return shape so App.tsx
 *     can swap in with minimal changes.
 *   - Keeps lastSeq across a direct→proxy switch so the server proxy's
 *     forwarded Last-Event-ID replays from where direct left off.
 *   - No automatic fallback back to direct once in proxy mode — the UI can
 *     call retryDirect() explicitly after a network change.
 */

import { connectTransport } from './transport.js'
import type { TransportState, ReconnectMeta } from './transport.js'

export type TransportMode = 'direct' | 'proxy'

export interface MachineTransportOptions {
  /** Target machine identity (UUID). Used in proxy URLs. */
  machineId: string
  /** Target machine's direct base URL including ?token= (machine sessionToken). */
  directUrl: string
  /** Cluster server base URL (no path). */
  serverUrl: string
  /** Cluster token used for /cluster/* auth. */
  clusterToken: string
  /** Max reconnect failures on direct before falling back. Default 3. */
  maxDirectFailures?: number
  /** Injectable factory for tests. */
  transportFactory?: typeof connectTransport
}

export type MachineTransportState = TransportState
export interface MachineTransportMeta extends ReconnectMeta {
  mode: TransportMode
}

type MessageCallback = (data: unknown) => void
type StateCallback = (state: MachineTransportState, meta?: MachineTransportMeta) => void

export interface MachineTransport {
  mode: TransportMode
  send(msg: unknown): Promise<boolean>
  onMessage(cb: MessageCallback): void
  onStateChange(cb: StateCallback): void
  /** Force re-try direct (after a network change for example). */
  retryDirect(): void
  /** Force switch to proxy immediately. */
  switchToProxy(): void
  close(): void
  getLastSeq(): number
}

type InnerTransport = ReturnType<typeof connectTransport>

export function connectMachineTransport(opts: MachineTransportOptions): MachineTransport {
  const maxDirectFailures = opts.maxDirectFailures ?? 3
  const factory = opts.transportFactory ?? connectTransport

  const messageCallbacks: MessageCallback[] = []
  const stateCallbacks: StateCallback[] = []
  let currentState: MachineTransportState = 'connecting'
  let mode: TransportMode = 'direct'
  let inner: InnerTransport | null = null
  let closed = false
  let directFailures = 0
  let lastSeq = 0

  function buildProxyUrl(): string {
    const u = new URL('/cluster/stream', opts.serverUrl)
    u.searchParams.set('machineId', opts.machineId)
    u.searchParams.set('token', opts.clusterToken)
    return u.toString()
  }

  function notifyState(state: MachineTransportState, meta?: ReconnectMeta) {
    currentState = state
    for (const cb of stateCallbacks) {
      try { cb(state, meta ? { ...meta, mode } : { attempt: 0, maxAttempts: 0, mode }) } catch { /* swallow */ }
    }
  }

  function attach(t: InnerTransport): void {
    t.onMessage((msg) => {
      for (const cb of messageCallbacks) {
        try { cb(msg) } catch { /* swallow */ }
      }
    })
    t.onStateChange((state, meta) => {
      // Keep lastSeq in sync for potential fallback replay
      lastSeq = t.getLastSeq()

      if (state === 'disconnected' && mode === 'direct' && !closed) {
        // Direct path gave up — switch to proxy
        directFailures = maxDirectFailures
        switchToProxy()
        return
      }
      if (state === 'reconnecting' && mode === 'direct') {
        directFailures++
        if (directFailures >= maxDirectFailures) {
          switchToProxy()
          return
        }
      }
      if (state === 'connected') {
        directFailures = 0
      }
      notifyState(state, meta)
    })
  }

  function openDirect(): void {
    if (closed) return
    mode = 'direct'
    directFailures = 0
    inner = factory(opts.directUrl)
    attach(inner)
  }

  function switchToProxy(): void {
    if (closed || mode === 'proxy') return
    const prev = inner
    inner = null
    mode = 'proxy'
    // Wait a tick for the old transport's close() so lastSeq is captured,
    // then open a new proxy-mode transport.
    try { prev?.close() } catch { /* ignore */ }
    inner = factory(buildProxyUrl())
    attach(inner)
  }

  function retryDirect(): void {
    if (closed) return
    if (mode === 'direct') return
    const prev = inner
    inner = null
    try { prev?.close() } catch { /* ignore */ }
    openDirect()
  }

  // Start
  openDirect()

  return {
    get mode(): TransportMode { return mode },
    send(msg: unknown): Promise<boolean> {
      if (!inner) return Promise.resolve(false)
      if (mode === 'direct') return inner.send(msg)
      // Proxy mode: send via server's /cluster/message
      return sendViaProxy(opts.serverUrl, opts.clusterToken, opts.machineId, msg)
    },
    onMessage(cb) { messageCallbacks.push(cb) },
    onStateChange(cb) {
      stateCallbacks.push(cb)
      try { cb(currentState, { attempt: 0, maxAttempts: 0, mode }) } catch { /* swallow */ }
    },
    retryDirect,
    switchToProxy,
    close(): void {
      closed = true
      try { inner?.close() } catch { /* ignore */ }
      inner = null
    },
    getLastSeq(): number {
      return inner?.getLastSeq() ?? lastSeq
    },
  }
}

// ---------------------------------------------------------------------------
// Proxy POST helper
// ---------------------------------------------------------------------------

async function sendViaProxy(
  serverUrl: string,
  clusterToken: string,
  machineId: string,
  msg: unknown,
): Promise<boolean> {
  const u = new URL('/cluster/message', serverUrl)
  u.searchParams.set('machineId', machineId)
  const body = typeof msg === 'object' && msg !== null
    ? { ...msg, _messageId: crypto.randomUUID() }
    : { payload: msg, _messageId: crypto.randomUUID() }
  try {
    const res = await fetch(u.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clusterToken}`,
      },
      body: JSON.stringify(body),
    })
    return res.ok
  } catch {
    return false
  }
}
