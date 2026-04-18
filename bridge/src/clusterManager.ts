/**
 * clusterManager.ts — Machine state cache and timeout detection (server-side).
 *
 * Tracks all registered client bridges, receives their heartbeats, and exposes
 * a query interface. Persists state to disk (debounced + atomic) so the server
 * can survive restarts without losing known machine registrations.
 *
 * Security model:
 *   Every machine registers with a `sessionToken` that the server holds as the
 *   machine's identity proof. Subsequent heartbeats must present the same
 *   token; mismatched heartbeats are rejected. Re-registration by a different
 *   caller is forbidden unless the incoming request matches the stored token.
 *
 * Architecture:
 *   - In-memory Map<machineId, MachineState> as the single source of truth.
 *   - setInterval sweep marks machines offline when lastSeen > offlineTimeoutMs.
 *   - Serialized async writer for persistence — never two writes in flight.
 *   - Atomic writes via tmp-file + rename(), so crashes cannot leave partial JSON.
 *   - Self entry (server's own machine) is always refreshed on listMachines()
 *     and never subject to offline sweep.
 *   - Construction is async via `createClusterManager()` — persisted state is
 *     fully loaded before the manager is handed back, avoiding load-vs-write
 *     races.
 */

import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { SessionInfo } from './sessionScanner.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MachineStatus = 'idle' | 'running' | 'spawning' | 'stopping' | 'offline'

export interface RegisterRequest {
  machineId: string
  name: string
  /** Normalized http(s) URL where this client's bridge listens */
  url: string
  /** Client's own session token — also used as the machine's identity proof */
  sessionToken: string
  os?: string
  hostname?: string
}

export interface HeartbeatRequest {
  machineId: string
  /** Must match the sessionToken from the original register() — identity proof */
  sessionToken: string
  status: MachineStatus
  sessionId?: string
  project?: string
  sessions?: SessionInfo[]
}

export interface MachineState {
  machineId: string
  name: string
  url: string
  sessionToken: string
  status: MachineStatus
  sessionId?: string
  project?: string
  sessions: SessionInfo[]
  lastSeen: number
  firstSeen: number
  os?: string
  hostname?: string
}

export interface ClusterManager {
  register(req: RegisterRequest): { ok: boolean; error?: string }
  heartbeat(req: HeartbeatRequest): { ok: boolean; error?: string }
  listMachines(): MachineState[]
  getMachine(machineId: string): MachineState | undefined
  close(): Promise<void>
}

export interface ClusterManagerOptions {
  /** Timeout in ms after which a machine is considered offline. Default: 90_000 */
  offlineTimeoutMs?: number
  /** Sweep interval in ms to check for offline machines. Default: 15_000 */
  sweepIntervalMs?: number
  /** Optional path for persistence. Default: ~/.remote-cc/cluster-state.json */
  persistPath?: string
  /** Disable persistence entirely. Default: false */
  noPersist?: boolean
  /** Debounce ms for persistence writes. Default: 5000 */
  persistDebounceMs?: number
  /** Self entry — always online, never subject to sweep. */
  self?: {
    machineId: string
    name: string
    url: string
    sessionToken: string
    os?: string
    hostname?: string
  }
}

// ---------------------------------------------------------------------------
// Persistence file format
// ---------------------------------------------------------------------------

interface PersistedState {
  version: 1
  machines: Record<string, MachineState>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Constant-time string compare to avoid token-length / token-content leaks. */
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8')
  const bBuf = Buffer.from(b, 'utf8')
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

// ---------------------------------------------------------------------------
// Factory (async)
// ---------------------------------------------------------------------------

/**
 * Create a ClusterManager. Async so that persisted state is fully loaded
 * before any register/heartbeat can hit the in-memory Map (avoids load
 * clobbering live writes).
 */
export async function createClusterManager(
  opts?: ClusterManagerOptions,
): Promise<ClusterManager> {
  const offlineTimeoutMs = opts?.offlineTimeoutMs ?? 90_000
  const sweepIntervalMs = opts?.sweepIntervalMs ?? 15_000
  const persistDebounceMs = opts?.persistDebounceMs ?? 5_000
  const noPersist = opts?.noPersist ?? false
  const selfConfig = opts?.self ?? null
  const persistPath =
    opts?.persistPath ?? join(homedir(), '.remote-cc', 'cluster-state.json')

  const machines = new Map<string, MachineState>()

  // -------------------------------------------------------------------------
  // 1. Load persisted state BEFORE returning the manager
  // -------------------------------------------------------------------------

  if (!noPersist) {
    try {
      const raw = await readFile(persistPath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as Record<string, unknown>).version === 1 &&
        typeof (parsed as Record<string, unknown>).machines === 'object'
      ) {
        const data = parsed as PersistedState
        for (const [id, entry] of Object.entries(data.machines)) {
          // Skip any persisted entry that shadows the current self — self is
          // canonical from opts.self, never from disk.
          if (selfConfig && id === selfConfig.machineId) continue
          // Mark persisted entries offline; they re-sync via heartbeat.
          machines.set(id, { ...entry, status: 'offline' })
        }
      } else {
        console.warn('[clusterManager] Unrecognised persist format — ignoring')
      }
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException
      if (e.code && e.code !== 'ENOENT') {
        console.warn('[clusterManager] Failed to load persist file:', e.message)
      }
      // ENOENT or parse error: start fresh
    }
  }

  // -------------------------------------------------------------------------
  // 2. Persistence: serialized atomic writer
  // -------------------------------------------------------------------------

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let writeChain: Promise<void> = Promise.resolve()
  let closed = false

  function schedulePersist(): void {
    if (noPersist || closed) return
    if (persistTimer !== null) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      // Chain on the previous write so only one is ever in flight.
      writeChain = writeChain.then(() => flushPersist()).catch(() => undefined)
    }, persistDebounceMs)
    if ((persistTimer as unknown as { unref?: () => void }).unref) {
      (persistTimer as unknown as { unref: () => void }).unref()
    }
  }

  async function flushPersist(): Promise<void> {
    if (noPersist) return
    const payload: PersistedState = {
      version: 1,
      // Exclude self from persistence — self is always provided fresh from opts
      machines: Object.fromEntries(
        [...machines.entries()].filter(
          ([id]) => !(selfConfig && id === selfConfig.machineId),
        ),
      ),
    }
    const json = JSON.stringify(payload, null, 2)
    const dir = dirname(persistPath)
    const tmpPath = `${persistPath}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(tmpPath, json, 'utf8')
      // Atomic rename on POSIX — target file is never left partial
      await rename(tmpPath, persistPath)
    } catch (err) {
      console.warn('[clusterManager] Persist failed:', (err as Error).message)
      // Best-effort cleanup of tmp
      try {
        await unlink(tmpPath)
      } catch {
        // ignore
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. Offline sweep
  // -------------------------------------------------------------------------

  const sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [id, machine] of machines.entries()) {
      if (selfConfig && id === selfConfig.machineId) continue
      if (
        machine.status !== 'offline' &&
        now - machine.lastSeen > offlineTimeoutMs
      ) {
        machines.set(id, { ...machine, status: 'offline' })
      }
    }
  }, sweepIntervalMs)
  if ((sweepTimer as unknown as { unref?: () => void }).unref) {
    (sweepTimer as unknown as { unref: () => void }).unref()
  }

  // -------------------------------------------------------------------------
  // 4. register()
  // -------------------------------------------------------------------------

  function register(req: RegisterRequest): { ok: boolean; error?: string } {
    if (!req.machineId || typeof req.machineId !== 'string') {
      return { ok: false, error: 'machineId must be a non-empty string' }
    }
    if (!req.name || typeof req.name !== 'string') {
      return { ok: false, error: 'name must be a non-empty string' }
    }
    if (!req.sessionToken || typeof req.sessionToken !== 'string') {
      return { ok: false, error: 'sessionToken must be a non-empty string' }
    }

    // Validate URL
    let parsedUrl: URL
    try {
      parsedUrl = new URL(req.url)
    } catch {
      return { ok: false, error: `invalid URL "${req.url}"` }
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return { ok: false, error: `URL must use http or https, got "${parsedUrl.protocol}"` }
    }

    // Prevent registering over the server's own self entry
    if (selfConfig && req.machineId === selfConfig.machineId) {
      return { ok: false, error: 'machineId conflicts with server self' }
    }

    const now = Date.now()
    const existing = machines.get(req.machineId)

    // Identity proof: if this machineId was seen before, the incoming token
    // must match. This prevents a caller who only has the cluster token from
    // impersonating another machine.
    if (existing && !safeEqual(existing.sessionToken, req.sessionToken)) {
      return { ok: false, error: 'sessionToken does not match existing registration for this machineId' }
    }

    const state: MachineState = {
      machineId: req.machineId,
      name: req.name,
      url: req.url,
      sessionToken: req.sessionToken,
      // Fresh register = idle. Keep status if re-registering while running.
      status: existing?.status === 'offline' || !existing ? 'idle' : existing.status,
      sessionId: existing?.sessionId,
      project: existing?.project,
      sessions: existing?.sessions ?? [],
      lastSeen: now,
      firstSeen: existing?.firstSeen ?? now,
      os: req.os,
      hostname: req.hostname,
    }

    machines.set(req.machineId, state)
    schedulePersist()
    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // 5. heartbeat()
  // -------------------------------------------------------------------------

  function heartbeat(req: HeartbeatRequest): { ok: boolean; error?: string } {
    if (!req.machineId || !req.sessionToken) {
      return { ok: false, error: 'machineId and sessionToken required' }
    }

    const existing = machines.get(req.machineId)
    if (!existing) {
      return { ok: false, error: 'not registered' }
    }
    if (!safeEqual(existing.sessionToken, req.sessionToken)) {
      return { ok: false, error: 'sessionToken mismatch' }
    }

    const updated: MachineState = {
      ...existing,
      status: req.status,
      lastSeen: Date.now(),
    }
    if (req.sessionId !== undefined) updated.sessionId = req.sessionId
    if (req.project !== undefined) updated.project = req.project
    if (req.sessions !== undefined) updated.sessions = req.sessions

    machines.set(req.machineId, updated)
    schedulePersist()
    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // 6. listMachines()
  // -------------------------------------------------------------------------

  function listMachines(): MachineState[] {
    const result: MachineState[] = []

    if (selfConfig) {
      const now = Date.now()
      const existing = machines.get(selfConfig.machineId)
      const selfEntry: MachineState = {
        machineId: selfConfig.machineId,
        name: selfConfig.name,
        url: selfConfig.url,
        sessionToken: selfConfig.sessionToken,
        status: 'idle',
        sessions: existing?.sessions ?? [],
        lastSeen: now,
        firstSeen: existing?.firstSeen ?? now,
        os: selfConfig.os,
        hostname: selfConfig.hostname,
      }
      machines.set(selfConfig.machineId, selfEntry)
      result.push(selfEntry)
    }

    for (const [id, machine] of machines.entries()) {
      if (selfConfig && id === selfConfig.machineId) continue
      result.push(machine)
    }

    result.sort((a, b) => a.name.localeCompare(b.name))
    return result
  }

  // -------------------------------------------------------------------------
  // 7. getMachine()
  // -------------------------------------------------------------------------

  function getMachine(machineId: string): MachineState | undefined {
    // For the self machineId, return a freshly-computed entry so callers
    // can't observe it as offline between listMachines() calls.
    if (selfConfig && machineId === selfConfig.machineId) {
      // Use listMachines() to refresh in-memory entry, then fetch
      listMachines()
    }
    return machines.get(machineId)
  }

  // -------------------------------------------------------------------------
  // 8. close()
  // -------------------------------------------------------------------------

  async function close(): Promise<void> {
    closed = true
    clearInterval(sweepTimer)
    if (persistTimer !== null) {
      clearTimeout(persistTimer)
      persistTimer = null
      writeChain = writeChain.then(() => flushPersist()).catch(() => undefined)
    }
    await writeChain
  }

  return { register, heartbeat, listMachines, getMachine, close }
}
