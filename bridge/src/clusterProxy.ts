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
  } = deps

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
      const res = await fetchImpl(joinUrl(machine.url, path), {
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

    // Forward Last-Event-ID if present so target can replay missed messages
    const lastEventId = clientReq.headers['last-event-id']
    const headers: Record<string, string> = {
      'Accept': 'text/event-stream',
      'Authorization': `Bearer ${machine.sessionToken}`,
    }
    if (typeof lastEventId === 'string') headers['Last-Event-ID'] = lastEventId

    const controller = new AbortController()
    // Abort upstream fetch if client disconnects
    const onClose = () => controller.abort()
    clientReq.once('close', onClose)

    try {
      const upstream = await fetchImpl(joinUrl(machine.url, '/events/stream'), {
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
      for (;;) {
        // Stop if client already disconnected between chunks
        if (controller.signal.aborted || clientRes.writableEnded || clientRes.destroyed) break

        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue

        const ok = clientRes.write(Buffer.from(value))
        if (ok) continue

        // Wait for drain — but race against disconnect so we don't hang
        // forever if the socket dies without emitting 'drain'.
        await new Promise<void>((resolve) => {
          const onDrain = () => { cleanup(); resolve() }
          const onClose = () => { cleanup(); resolve() }
          const onError = () => { cleanup(); resolve() }
          const cleanup = () => {
            clientRes.off('drain', onDrain)
            clientRes.off('close', onClose)
            clientRes.off('error', onError)
            clientReq.off('close', onClose)
          }
          clientRes.once('drain', onDrain)
          clientRes.once('close', onClose)
          clientRes.once('error', onError)
          clientReq.once('close', onClose)
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
      clientReq.off('close', onClose)
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
      const res = await fetchImpl(joinUrl(machine.url, '/messages'), {
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
