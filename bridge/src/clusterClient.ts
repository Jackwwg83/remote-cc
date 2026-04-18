/**
 * clusterClient.ts — Cluster client for bridge registration + heartbeats
 *
 * Runs on "client" bridges (--role client). Handles:
 *   1. POST /cluster/register on startup (with exponential backoff retry)
 *   2. POST /cluster/heartbeat every heartbeatIntervalMs (default 30s)
 *   3. Re-registration if server returns 401 or 404 (server restart)
 */

import type { SessionInfo } from './sessionScanner.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ClientStatus = 'idle' | 'running' | 'spawning' | 'stopping'

export interface ClusterClientOptions {
  /** Server's base URL (already validated in clusterConfig) */
  serverUrl: string
  /** Cluster token to authenticate with the server */
  clusterToken: string
  /** This machine's ID */
  machineId: string
  /** Display name */
  machineName: string
  /** This bridge's listen URL (http://host:port) — how the server should reach us */
  selfUrl: string
  /** This bridge's own session token — how the server proves heartbeats are from us */
  sessionToken: string
  /** Optional: os.platform() */
  os?: string
  /** Optional: os.hostname() */
  hostname?: string
  /** Override heartbeat interval (default 30_000 ms) */
  heartbeatIntervalMs?: number
  /** Override register retry max attempts (default infinite until success). Mostly for tests. */
  maxRegisterAttempts?: number
  /** Injectable fetch for tests */
  fetchImpl?: typeof fetch
}

export interface ClusterClient {
  /** Start registration + heartbeats. Returns when first register succeeds (or rejects after maxRegisterAttempts). */
  start(): Promise<void>
  /** Update the local state snapshot. Next heartbeat will include it. */
  updateStatus(s: { status: ClientStatus; sessionId?: string; project?: string; sessions?: SessionInfo[] }): void
  /** Stop all timers. */
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface LocalState {
  status: ClientStatus
  sessionId?: string
  project?: string
  sessions?: SessionInfo[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clamp backoff: 1s, 2s, 4s, 8s, 16s, 30s max */
function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

  let state: LocalState = { status: 'idle' }
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let closed = false

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  async function doRegister(): Promise<void> {
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
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Register HTTP ${res.status}: ${text}`)
    }

    const json = await res.json() as { ok: boolean; error?: string }
    if (!json.ok) {
      throw new Error(`Register rejected by server: ${json.error ?? 'unknown error'}`)
    }
  }

  async function registerWithRetry(): Promise<void> {
    let attempt = 0
    for (;;) {
      if (closed) return

      try {
        await doRegister()
        return
      } catch (err) {
        const isServerRejection =
          err instanceof Error && err.message.startsWith('Register rejected by server:')

        if (isServerRejection) {
          // Server explicitly rejected — don't retry
          throw err
        }

        attempt++
        if (maxRegisterAttempts !== undefined && attempt >= maxRegisterAttempts) {
          throw new Error(`Failed to register after ${attempt} attempts: ${(err as Error).message}`)
        }

        const delay = backoffMs(attempt - 1)
        console.warn(`[clusterClient] Register attempt ${attempt} failed, retrying in ${delay}ms:`, (err as Error).message)
        await sleep(delay)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  async function doHeartbeat(): Promise<void> {
    if (closed) return

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
      })
    } catch (err) {
      console.warn('[clusterClient] Heartbeat network error:', (err as Error).message)
      return
    }

    if (res.status === 401 || res.status === 404) {
      // Server probably restarted — re-register
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
  }

  function startHeartbeatTimer(): void {
    if (heartbeatTimer !== null || closed) return

    heartbeatTimer = setInterval(() => {
      doHeartbeat().catch((err) => {
        console.warn('[clusterClient] Heartbeat unexpected error:', err)
      })
    }, heartbeatIntervalMs)

    // Don't block Node process exit
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
    },
  }
}
