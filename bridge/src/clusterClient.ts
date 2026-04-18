/**
 * clusterClient.ts — Cluster client for bridge registration + heartbeats
 *
 * Runs on "client" bridges (--role client). Handles:
 *   1. POST /cluster/register on startup (with exponential backoff + jitter retry)
 *   2. POST /cluster/heartbeat every heartbeatIntervalMs (default 30s)
 *   3. Re-registration if server returns 401 or 404 (server restart)
 *
 * Concurrency guarantees:
 *   - Only one heartbeat in flight at a time (guard prevents overlap on slow server)
 *   - Only one registration in flight at a time (re-register during heartbeat reuses it)
 *   - close() aborts in-flight fetch + wakes pending sleep() via AbortController
 *
 * Permanent-failure policy:
 *   - 400 or 401 from register → fail fast, don't loop (misconfiguration)
 *   - 5xx / network errors → retry with exponential backoff + 25% jitter
 *   - Server-rejected `{ok:false}` → fail fast
 */

import type { SessionInfo } from './sessionScanner.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ClientStatus = 'idle' | 'running' | 'spawning' | 'stopping'

export interface ClusterClientOptions {
  serverUrl: string
  clusterToken: string
  machineId: string
  machineName: string
  /** This bridge's listen URL (http://host:port) */
  selfUrl: string
  /** This bridge's own session token — identity proof to the server */
  sessionToken: string
  os?: string
  hostname?: string
  /** Override heartbeat interval (default 30_000 ms) */
  heartbeatIntervalMs?: number
  /** Register retry max attempts (default Infinity). For tests. */
  maxRegisterAttempts?: number
  /** Injectable fetch for tests */
  fetchImpl?: typeof fetch
}

export interface ClusterClient {
  /** Start registration + heartbeats. Resolves after first register succeeds. */
  start(): Promise<void>
  updateStatus(s: { status: ClientStatus; sessionId?: string; project?: string; sessions?: SessionInfo[] }): void
  /** Stop all timers, abort in-flight requests, cancel pending sleep. */
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Exponential backoff with ±25% jitter. Caps at 30s. */
function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 30_000)
  const jitter = (Math.random() - 0.5) * 0.5 * base // ±25%
  return Math.max(100, Math.round(base + jitter))
}

/** Abortable sleep — resolves normally on timeout, rejects on abort. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('aborted'))
    const id = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(id)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Check if an HTTP error from register is permanent (no retry). */
function isPermanentRegisterError(status: number): boolean {
  return status === 400 || status === 401 || status === 403
}

/** Internal error type carrying HTTP status so retry logic can decide. */
class RegisterHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'RegisterHttpError'
  }
}

class ServerRejectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServerRejectError'
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createClusterClient(opts: ClusterClientOptions): ClusterClient {
  const {
    serverUrl,
    clusterToken,
    machineId,
    machineName,
    selfUrl,
    sessionToken,
    heartbeatIntervalMs = 30_000,
    maxRegisterAttempts,
    fetchImpl = fetch,
  } = opts

  let state = { status: 'idle' as ClientStatus } as {
    status: ClientStatus
    sessionId?: string
    project?: string
    sessions?: SessionInfo[]
  }

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  const abortController = new AbortController()
  let closed = false

  // Concurrency guards
  let registerInFlight: Promise<void> | null = null
  let heartbeatInFlight: Promise<void> | null = null

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  async function doRegisterOnce(): Promise<void> {
    const body = JSON.stringify({
      machineId,
      name: machineName,
      url: selfUrl,
      sessionToken,
      os: opts.os,
      hostname: opts.hostname,
    })

    const res = await fetchImpl(`${serverUrl}/cluster/register`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${clusterToken}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: abortController.signal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new RegisterHttpError(res.status, `Register HTTP ${res.status}: ${text}`)
    }

    const json = await res.json() as { ok: boolean; error?: string }
    if (!json.ok) {
      throw new ServerRejectError(`Register rejected by server: ${json.error ?? 'unknown error'}`)
    }
  }

  async function registerWithRetry(): Promise<void> {
    // Dedupe concurrent register calls
    if (registerInFlight) return registerInFlight
    registerInFlight = (async () => {
      try {
        let attempt = 0
        for (;;) {
          if (closed) return
          try {
            await doRegisterOnce()
            return
          } catch (err) {
            if (err instanceof ServerRejectError) throw err
            if (err instanceof RegisterHttpError && isPermanentRegisterError(err.status)) {
              throw err
            }
            if (abortController.signal.aborted) return

            attempt++
            if (maxRegisterAttempts !== undefined && attempt >= maxRegisterAttempts) {
              throw new Error(`Failed to register after ${attempt} attempts: ${(err as Error).message}`)
            }
            const delay = backoffMs(attempt - 1)
            console.warn(
              `[clusterClient] Register attempt ${attempt} failed, retrying in ${delay}ms:`,
              (err as Error).message,
            )
            try {
              await sleep(delay, abortController.signal)
            } catch {
              return // aborted
            }
          }
        }
      } finally {
        registerInFlight = null
      }
    })()
    return registerInFlight
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  async function doHeartbeat(): Promise<void> {
    if (closed) return
    // Skip if previous heartbeat still running (slow server scenario)
    if (heartbeatInFlight) return
    heartbeatInFlight = (async () => {
      try {
        const snapshot = state
        const body = JSON.stringify({
          machineId,
          sessionToken,
          status: snapshot.status,
          ...(snapshot.sessionId !== undefined ? { sessionId: snapshot.sessionId } : {}),
          ...(snapshot.project !== undefined ? { project: snapshot.project } : {}),
          ...(snapshot.sessions !== undefined ? { sessions: snapshot.sessions } : {}),
        })

        let res: Response
        try {
          res = await fetchImpl(`${serverUrl}/cluster/heartbeat`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${clusterToken}`,
              'Content-Type': 'application/json',
            },
            body,
            signal: abortController.signal,
          })
        } catch (err) {
          if (abortController.signal.aborted) return
          console.warn('[clusterClient] Heartbeat network error:', (err as Error).message)
          return
        }

        if (res.status === 401 || res.status === 404) {
          console.warn(`[clusterClient] Heartbeat got ${res.status}, re-registering…`)
          try {
            await registerWithRetry()
          } catch (err) {
            console.warn('[clusterClient] Re-registration failed:', (err as Error).message)
          }
          return
        }

        if (!res.ok) {
          console.warn(`[clusterClient] Heartbeat HTTP ${res.status}`)
        }
      } finally {
        heartbeatInFlight = null
      }
    })()
    return heartbeatInFlight
  }

  function startHeartbeatTimer(): void {
    if (heartbeatTimer !== null || closed) return
    heartbeatTimer = setInterval(() => {
      doHeartbeat().catch((err) => {
        console.warn('[clusterClient] Heartbeat unexpected error:', err)
      })
    }, heartbeatIntervalMs)
    heartbeatTimer.unref()
  }

  // -------------------------------------------------------------------------
  // Public interface
  // -------------------------------------------------------------------------

  return {
    async start(): Promise<void> {
      await registerWithRetry()
      startHeartbeatTimer()
    },

    updateStatus(s): void {
      state = { ...state, ...s }
    },

    async close(): Promise<void> {
      closed = true
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
      // Abort in-flight fetch + sleep
      abortController.abort(new Error('clusterClient closed'))
      // Await any pending work for cleanliness
      await Promise.allSettled([registerInFlight, heartbeatInFlight])
    },
  }
}
