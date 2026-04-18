/**
 * machineTransport.ts — Multi-machine transport with direct → proxy fallback.
 *
 * Wraps connectTransport() so the UI can target a specific machine across the
 * cluster. Tries a direct connection first (best latency, no server proxy
 * load); if the direct path stays unhealthy (repeated reconnect failures or
 * "disconnected" final state), falls back to routing through the cluster
 * server's /cluster/stream + /cluster/message proxy endpoints.
 *
 * Implementation notes:
 *   - Uses connectTransport's ssePath/postPath/extraQuery options so proxy
 *     mode actually hits /cluster/stream + /cluster/message (not /events/stream)
 *   - Propagates lastSeq from the dying inner transport into the new one via
 *     initialSeq, so the proxy's Last-Event-ID forwarding resumes correctly
 *   - Version-gates inner transport callbacks: stale events from a closed
 *     inner are discarded even if they race after close()
 */

import { connectTransport } from './transport.js'
import type { TransportState, ReconnectMeta, TransportOptions } from './transport.js'

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
  let innerVersion = 0
  let closed = false
  let directFailures = 0
  /** Cached seq across switches (survives inner.close()). */
  let cachedSeq = 0

  function notifyState(state: MachineTransportState, meta?: ReconnectMeta) {
    currentState = state
    for (const cb of stateCallbacks) {
      try {
        cb(state, meta ? { ...meta, mode } : { attempt: 0, maxAttempts: 0, mode })
      } catch { /* swallow */ }
    }
  }

  function attach(t: InnerTransport, version: number): void {
    t.onMessage((msg) => {
      // Discard messages from a retired inner transport
      if (version !== innerVersion || closed) return
      cachedSeq = t.getLastSeq()
      for (const cb of messageCallbacks) {
        try { cb(msg) } catch { /* swallow */ }
      }
    })
    t.onStateChange((state, meta) => {
      if (version !== innerVersion || closed) return
      cachedSeq = t.getLastSeq()

      if (state === 'disconnected' && mode === 'direct' && !closed) {
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
    innerVersion++
    // Direct hits the machine's /events/stream + /messages with its
    // sessionToken — defaults are fine, just pass initialSeq for replay.
    const directOpts: TransportOptions = {}
    if (cachedSeq > 0) directOpts.initialSeq = cachedSeq
    inner = factory(opts.directUrl, directOpts)
    attach(inner, innerVersion)
  }

  function openProxy(): void {
    if (closed) return
    mode = 'proxy'
    innerVersion++
    // Proxy mode: SSE goes to /cluster/stream?machineId=X, POST goes to
    // /cluster/message?machineId=X, all under the server's origin with
    // cluster token as bearer.
    const proxyBase = `${opts.serverUrl}${opts.serverUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(opts.clusterToken)}`
    const proxyOpts: TransportOptions = {
      ssePath: '/cluster/stream',
      postPath: '/cluster/message',
      extraQuery: { machineId: opts.machineId },
    }
    if (cachedSeq > 0) proxyOpts.initialSeq = cachedSeq
    inner = factory(proxyBase, proxyOpts)
    attach(inner, innerVersion)
  }

  function switchToProxy(): void {
    if (closed || mode === 'proxy') return
    const prev = inner
    // Bump version first so any late callbacks from prev are ignored
    innerVersion++
    try { prev?.close() } catch { /* ignore */ }
    // Re-open as proxy (also bumps version but that's fine)
    openProxy()
  }

  function retryDirect(): void {
    if (closed) return
    if (mode === 'direct') return
    const prev = inner
    innerVersion++
    try { prev?.close() } catch { /* ignore */ }
    openDirect()
  }

  // Start
  openDirect()

  return {
    get mode(): TransportMode { return mode },
    send(msg: unknown): Promise<boolean> {
      if (!inner || closed) return Promise.resolve(false)
      return inner.send(msg)
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
      innerVersion++
      try { inner?.close() } catch { /* ignore */ }
      inner = null
    },
    getLastSeq(): number {
      return inner?.getLastSeq() ?? cachedSeq
    },
  }
}
