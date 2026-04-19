/**
 * clusterProxy.ts — Server-side proxy for cross-machine control + streaming.
 *
 * When the phone (or any UI) can't reach a client bridge directly, the server
 * acts as a proxy. Three proxy operations:
 *
 *   1. forwardAction()   — POST /cluster/action        → target /sessions/start|stop
 *   2. proxyStream()     — GET  /cluster/stream?mid=X  → target /events/stream
 *   3. proxyMessage()    — POST /cluster/message?mid=X → target /messages
 *
 * All proxies use the target machine's own sessionToken (stored by clusterManager
 * on register) as the Bearer token. The cluster token is the caller's proof of
 * authorization for the proxy endpoints themselves.
 *
 * Error taxonomy:
 *   - 404  machine not found / offline
 *   - 502  target responded with network error or non-2xx on start/stop
 *   - 504  target timed out
 *   - 401  caller didn't present cluster token (enforced by httpServer, not here)
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ClusterManager, MachineState } from './clusterManager.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ClusterAction = 'start_session' | 'stop_session'

export interface ClusterActionRequest {
  machineId: string
  action: ClusterAction
  sessionId?: string
  cwd?: string
}

export interface ActionResult {
  status: number
  body: unknown
}

export interface ClusterProxyDeps {
  cluster: ClusterManager
  /** Injectable fetch for tests */
  fetchImpl?: typeof fetch
  /** Default request timeout in ms. Default: 30_000 */
  actionTimeoutMs?: number
  /** POST message timeout in ms. Default: 10_000 */
  messageTimeoutMs?: number
  /**
   * The server's own machineId. When a proxy request targets this id,
   * we rewrite the outgoing URL to `selfLoopbackUrl` instead of the
   * advertised mesh URL — because on Cloudflare WARP (and some Tailscale
   * configs) a host cannot fetch its own mesh IP, those packets don't
   * loop back through the tunnel. Without this rewrite every proxy
   * call to self times out with "fetch failed".
   */
  selfMachineId?: string
  /** e.g. http://localhost:7860 — reliable loopback for self-target proxy. */
  selfLoopbackUrl?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the live machine record or null if unknown. */
function lookupMachine(cluster: ClusterManager, machineId: string): MachineState | null {
  if (!machineId) return null
  const m = cluster.getMachine(machineId)
  return m ?? null
}

/** Returns true if a machine is usable for proxying (online + has sessionToken + url). */
function isOnline(m: MachineState): boolean {
  return m.status !== 'offline' && Boolean(m.url) && Boolean(m.sessionToken)
}

/** Build a URL joining origin + path. Assumes origin already normalized (no trailing slash). */
function joinUrl(origin: string, path: string): string {
  return origin.replace(/\/$/, '') + (path.startsWith('/') ? path : '/' + path)
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createClusterProxy(deps: ClusterProxyDeps) {
  const {
    cluster,
    fetchImpl = fetch,
    actionTimeoutMs = 30_000,
    messageTimeoutMs = 10_000,
    selfMachineId,
    selfLoopbackUrl,
  } = deps

  /** Pick the outgoing base URL: loopback for self, mesh URL for others. */
  function targetBaseUrl(m: MachineState): string {
    if (selfMachineId && m.machineId === selfMachineId && selfLoopbackUrl) {
      return selfLoopbackUrl
    }
    return m.url
  }

  // -------------------------------------------------------------------------
  // 1. forwardAction — POST /cluster/action
  // -------------------------------------------------------------------------

  async function forwardAction(req: ClusterActionRequest): Promise<ActionResult> {
    const machine = lookupMachine(cluster, req.machineId)
    if (!machine) {
      return { status: 404, body: { error: 'Machine not registered', machineId: req.machineId } }
    }
    if (!isOnline(machine)) {
      return { status: 404, body: { error: 'Machine offline', machineId: req.machineId, status: machine.status } }
    }

    let path: string
    let body: Record<string, unknown> | undefined

    if (req.action === 'start_session') {
      path = '/sessions/start'
      body = {}
      if (req.sessionId) body.sessionId = req.sessionId
      if (req.cwd) body.cwd = req.cwd
    } else if (req.action === 'stop_session') {
      path = '/sessions/stop'
      body = {}
    } else {
      return { status: 400, body: { error: `Unknown action: ${req.action as string}` } }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), actionTimeoutMs)

    try {
      const res = await fetchImpl(joinUrl(targetBaseUrl(machine), path), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${machine.sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      })
      const json = await res.json().catch(() => ({ error: 'Non-JSON response from target' }))
      return { status: res.status, body: json }
    } catch (err) {
      if (controller.signal.aborted) {
        return { status: 504, body: { error: 'Target machine timed out', machineId: req.machineId } }
      }
      return { status: 502, body: { error: 'Target machine unreachable', detail: (err as Error).message } }
    } finally {
      clearTimeout(timer)
    }
  }

  // -------------------------------------------------------------------------
  // 2. proxyStream — pipe remote SSE → local response
  // -------------------------------------------------------------------------

  async function proxyStream(
    machineId: string,
    clientReq: IncomingMessage,
    clientRes: ServerResponse,
  ): Promise<void> {
    const machine = lookupMachine(cluster, machineId)
    if (!machine || !isOnline(machine)) {
      clientRes.writeHead(404, { 'Content-Type': 'application/json' })
      clientRes.end(JSON.stringify({ error: 'Machine not registered or offline', machineId }))
      return
    }

    // Forward Last-Event-ID if present so target can replay missed messages.
    // Also forward from_seq query param — the browser EventSource doesn't set
    // Last-Event-ID until it has received an event, so on the first switch
    // from direct→proxy the caller uses ?from_seq=N to resume. Pass it through
    // so the target's SSE endpoint can serve the replay.
    const lastEventId = clientReq.headers['last-event-id']
    const headers: Record<string, string> = {
      'Accept': 'text/event-stream',
      'Authorization': `Bearer ${machine.sessionToken}`,
    }
    if (typeof lastEventId === 'string') headers['Last-Event-ID'] = lastEventId

    // Extract from_seq from client's request URL to forward to target
    let fromSeqQuery = ''
    try {
      const incoming = new URL(clientReq.url ?? '', 'http://localhost')
      const fromSeq = incoming.searchParams.get('from_seq')
      if (fromSeq) fromSeqQuery = `?from_seq=${encodeURIComponent(fromSeq)}`
    } catch { /* malformed URL — proceed without */ }

    const controller = new AbortController()
    // Reader is created after upstream resolves; disconnect handlers need to
    // cancel it too, so hold a ref we can fill in once it exists.
    let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null
    const abortUpstream = (): void => {
      if (!controller.signal.aborted) {
        try { controller.abort() } catch { /* already aborted */ }
      }
      if (upstreamReader) {
        try {
          // .cancel() returns a Promise that may reject with ABORT_ERR when
          // the fetch is being aborted — catch both sync throws and async
          // rejections to avoid unhandled promise rejections.
          const p = upstreamReader.cancel()
          if (p && typeof (p as Promise<unknown>).catch === 'function') {
            ;(p as Promise<unknown>).catch(() => {})
          }
        } catch { /* already cancelled */ }
      }
    }

    // Client disconnect signal: we use ServerResponse 'close' + the
    // underlying socket's 'close'. http.IncomingMessage 'close' is NOT
    // used — on Node >=18 it fires when the request completes (headers
    // received for a bodyless GET), not specifically on peer disconnect,
    // so relying on it could abort healthy streams.
    const onClientGone = () => abortUpstream()
    clientRes.once('close', onClientGone)
    clientRes.once('error', onClientGone)
    // Socket-level close catches the early window before writeHead too.
    const clientSocket = clientReq.socket
    if (clientSocket) clientSocket.once('close', onClientGone)

    try {
      const upstream = await fetchImpl(joinUrl(targetBaseUrl(machine), '/events/stream') + fromSeqQuery, {
        method: 'GET',
        headers,
        signal: controller.signal,
      })

      if (!upstream.ok || !upstream.body) {
        clientRes.writeHead(upstream.status || 502, { 'Content-Type': 'application/json' })
        clientRes.end(JSON.stringify({
          error: 'Target SSE connection failed',
          status: upstream.status,
        }))
        return
      }

      // Pass through SSE headers + keep connection alive
      clientRes.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })

      const reader = upstream.body.getReader()
      upstreamReader = reader

      for (;;) {
        if (controller.signal.aborted || clientRes.writableEnded || clientRes.destroyed) break

        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue

        const ok = clientRes.write(Buffer.from(value))
        if (ok) continue

        // Wait for drain — race against disconnect/error so we don't hang
        // forever if the socket dies without emitting 'drain'. The
        // top-level onClientGone listener will fire abortUpstream on
        // close/error too; the per-wait onDrain just unblocks the loop.
        await new Promise<void>((resolve) => {
          const onDrain = () => { cleanup(); resolve() }
          const onCloseLocal = () => { cleanup(); resolve() }
          const cleanup = () => {
            clientRes.off('drain', onDrain)
            clientRes.off('close', onCloseLocal)
            clientRes.off('error', onCloseLocal)
          }
          clientRes.once('drain', onDrain)
          clientRes.once('close', onCloseLocal)
          clientRes.once('error', onCloseLocal)
          // If already aborted by an earlier event handler, don't park
          if (controller.signal.aborted) { cleanup(); resolve() }
        })

        if (controller.signal.aborted || clientRes.writableEnded || clientRes.destroyed) break
      }
      try { clientRes.end() } catch { /* socket already closed */ }
    } catch (err) {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' })
        clientRes.end(JSON.stringify({
          error: 'Proxy stream failed',
          detail: (err as Error).message,
        }))
      } else {
        try { clientRes.end() } catch { /* socket already gone */ }
      }
    } finally {
      clientRes.off('close', onClientGone)
      clientRes.off('error', onClientGone)
      if (clientSocket) clientSocket.off('close', onClientGone)
    }
  }

  // -------------------------------------------------------------------------
  // 3. proxyMessage — POST /cluster/message?machineId=X
  // -------------------------------------------------------------------------

  async function proxyMessage(
    machineId: string,
    body: Record<string, unknown>,
  ): Promise<ActionResult> {
    const machine = lookupMachine(cluster, machineId)
    if (!machine) {
      return { status: 404, body: { error: 'Machine not registered', machineId } }
    }
    if (!isOnline(machine)) {
      return { status: 404, body: { error: 'Machine offline', machineId } }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), messageTimeoutMs)

    try {
      const res = await fetchImpl(joinUrl(targetBaseUrl(machine), '/messages'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${machine.sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const json = await res.json().catch(() => ({ error: 'Non-JSON response from target' }))
      return { status: res.status, body: json }
    } catch (err) {
      if (controller.signal.aborted) {
        return { status: 504, body: { error: 'Target message timed out', machineId } }
      }
      return { status: 502, body: { error: 'Target unreachable', detail: (err as Error).message } }
    } finally {
      clearTimeout(timer)
    }
  }

  return { forwardAction, proxyStream, proxyMessage }
}

export type ClusterProxy = ReturnType<typeof createClusterProxy>
