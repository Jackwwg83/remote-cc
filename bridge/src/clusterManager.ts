/**
 * clusterManager.ts — Machine state cache and timeout detection (server-side).
 *
 * Tracks all registered client bridges, receives their heartbeats, and exposes
 * a query interface. Persists state to disk (debounced) so the server can
 * survive restarts without losing known machine registrations.
 *
 * Architecture:
 *   - In-memory Map<machineId, MachineState> as the single source of truth.
 *   - setInterval sweep marks machines offline when lastSeen > offlineTimeoutMs.
 *   - Debounced fs.writeFile for persistence — avoids hammering disk on burst heartbeats.
 *   - Self entry (server's own machine) is always refreshed on listMachines() and
 *     never subject to offline sweep.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
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
  /** Client's own session token (per-bridge auth) */
  sessionToken: string
  /** Optional: 'darwin', 'linux', etc. */
  os?: string
  hostname?: string
}

export interface HeartbeatRequest {
  machineId: string
  status: MachineStatus
  /** Current session if running */
  sessionId?: string
  /** Current project cwd basename */
  project?: string
  /** Latest 20 session summaries (optional) */
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
  /** Epoch ms of last heartbeat or register */
  lastSeen: number
  /** Epoch ms of first registration */
  firstSeen: number
  os?: string
  hostname?: string
}

export interface ClusterManager {
  /** Called when a client sends POST /cluster/register */
  register(req: RegisterRequest): void
  /** Called when a client sends POST /cluster/heartbeat */
  heartbeat(req: HeartbeatRequest): { ok: boolean; error?: string }
  /** Get all known machines (server + clients) as an array */
  listMachines(): MachineState[]
  /** Get one machine by ID */
  getMachine(machineId: string): MachineState | undefined
  /** Stop the timeout sweep timer and flush any pending persistence write */
  close(): Promise<void>
}

export interface ClusterManagerOptions {
  /** Timeout in ms after which a machine is considered offline. Default: 90_000 */
  offlineTimeoutMs?: number
  /** Sweep interval in ms to check for offline machines. Default: 15_000 */
  sweepIntervalMs?: number
  /** Optional path for persistence. Default: ~/.remote-cc/cluster-state.json */
  persistPath?: string
  /** Disable persistence entirely (useful in tests). Default: false */
  noPersist?: boolean
  /** Debounce ms for persistence writes. Default: 5000 */
  persistDebounceMs?: number
  /**
   * Self entry for the server itself (always marked online).
   * If provided, included in listMachines(). Never subject to offline sweep.
   */
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
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a ClusterManager instance.
 *
 * Loads persisted state from disk on startup (marks all entries offline so they
 * re-sync when their clients send the next heartbeat). Starts a sweep timer to
 * detect stale machines.
 */
export function createClusterManager(opts?: ClusterManagerOptions): ClusterManager {
  const offlineTimeoutMs = opts?.offlineTimeoutMs ?? 90_000
  const sweepIntervalMs = opts?.sweepIntervalMs ?? 15_000
  const persistDebounceMs = opts?.persistDebounceMs ?? 5_000
  const noPersist = opts?.noPersist ?? false
  const selfConfig = opts?.self ?? null

  // Default persist path: ~/.remote-cc/cluster-state.json
  const persistPath =
    opts?.persistPath ?? join(homedir(), '.remote-cc', 'cluster-state.json')

  // In-memory state store
  const machines = new Map<string, MachineState>()

  // Pending persistence timer handle
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  // Track in-flight write so close() can await it
  let persistPromise: Promise<void> = Promise.resolve()

  // -------------------------------------------------------------------------
  // Startup: load persisted state
  // -------------------------------------------------------------------------

  // We kick off async load immediately but don't block construction.
  // Any register/heartbeat that arrives before load finishes is fine —
  // it will simply upsert into the Map.
  void loadPersistedState()

  async function loadPersistedState(): Promise<void> {
    if (noPersist) return

    let raw: string
    try {
      raw = await readFile(persistPath, 'utf8')
    } catch {
      // File doesn't exist yet or unreadable — start fresh
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      console.warn('[clusterManager] Corrupt persist file — ignoring:', persistPath)
      return
    }

    // Validate shape
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as Record<string, unknown>).version !== 1 ||
      typeof (parsed as Record<string, unknown>).machines !== 'object'
    ) {
      console.warn('[clusterManager] Unrecognised persist format — ignoring')
      return
    }

    const data = parsed as PersistedState

    for (const [id, entry] of Object.entries(data.machines)) {
      // Mark all persisted entries as offline — they'll re-sync via heartbeat
      machines.set(id, { ...entry, status: 'offline' })
    }
  }

  // -------------------------------------------------------------------------
  // Offline sweep timer
  // -------------------------------------------------------------------------

  const sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [id, machine] of machines.entries()) {
      // Self entry is exempt — never marked offline here
      if (selfConfig && id === selfConfig.machineId) continue
      if (machine.status !== 'offline' && now - machine.lastSeen >= offlineTimeoutMs) {
        machines.set(id, { ...machine, status: 'offline' })
      }
    }
  }, sweepIntervalMs)

  // Allow Node to exit even if this timer is still active
  if ((sweepTimer as unknown as { unref?: () => void }).unref) {
    (sweepTimer as unknown as { unref: () => void }).unref()
  }

  // -------------------------------------------------------------------------
  // Persistence helpers
  // -------------------------------------------------------------------------

  /** Schedule a debounced write of the full state to disk. */
  function schedulePersist(): void {
    if (noPersist) return

    if (persistTimer !== null) {
      clearTimeout(persistTimer)
    }

    persistTimer = setTimeout(() => {
      persistTimer = null
      persistPromise = flushPersist()
    }, persistDebounceMs)

    // Allow Node to exit even if this timer hasn't fired yet
    if ((persistTimer as unknown as { unref?: () => void }).unref) {
      (persistTimer as unknown as { unref: () => void }).unref()
    }
  }

  /** Write current state to disk immediately. Ignores errors. */
  async function flushPersist(): Promise<void> {
    if (noPersist) return

    const payload: PersistedState = {
      version: 1,
      machines: Object.fromEntries(machines.entries()),
    }

    const json = JSON.stringify(payload, null, 2)

    try {
      // Ensure directory exists (first run)
      await mkdir(dirname(persistPath), { recursive: true })
      await writeFile(persistPath, json, 'utf8')
    } catch (err) {
      console.warn('[clusterManager] Failed to persist state:', (err as Error).message)
    }
  }

  // -------------------------------------------------------------------------
  // register()
  // -------------------------------------------------------------------------

  function register(req: RegisterRequest): void {
    // Validate required fields
    if (!req.machineId || typeof req.machineId !== 'string') {
      throw new Error('register: machineId must be a non-empty string')
    }
    if (!req.name || typeof req.name !== 'string') {
      throw new Error('register: name must be a non-empty string')
    }

    // Validate URL — must be http(s)
    let parsedUrl: URL
    try {
      parsedUrl = new URL(req.url)
    } catch {
      throw new Error(`register: invalid URL "${req.url}"`)
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`register: URL must use http or https, got "${parsedUrl.protocol}"`)
    }

    const now = Date.now()
    const existing = machines.get(req.machineId)

    const state: MachineState = {
      machineId: req.machineId,
      name: req.name,
      url: req.url,
      sessionToken: req.sessionToken,
      // 新注册时状态为 idle；如果是重新注册（已存在），保留原有状态
      status: existing?.status === 'offline' ? 'idle' : (existing?.status ?? 'idle'),
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
  }

  // -------------------------------------------------------------------------
  // heartbeat()
  // -------------------------------------------------------------------------

  function heartbeat(req: HeartbeatRequest): { ok: boolean; error?: string } {
    const existing = machines.get(req.machineId)
    if (!existing) {
      return { ok: false, error: 'not registered' }
    }

    const updated: MachineState = {
      ...existing,
      status: req.status,
      lastSeen: Date.now(),
    }

    // 仅在提供时更新可选字段
    if (req.sessionId !== undefined) updated.sessionId = req.sessionId
    if (req.project !== undefined) updated.project = req.project
    if (req.sessions !== undefined) updated.sessions = req.sessions

    machines.set(req.machineId, updated)
    schedulePersist()

    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // listMachines()
  // -------------------------------------------------------------------------

  function listMachines(): MachineState[] {
    const result: MachineState[] = []

    // 添加 self 条目（如果配置了的话），刷新 lastSeen 以表示始终在线
    if (selfConfig) {
      const now = Date.now()
      const existing = machines.get(selfConfig.machineId)
      const selfEntry: MachineState = {
        machineId: selfConfig.machineId,
        name: selfConfig.name,
        url: selfConfig.url,
        sessionToken: selfConfig.sessionToken,
        status: 'idle', // server self is always online/idle
        sessions: existing?.sessions ?? [],
        lastSeen: now,
        firstSeen: existing?.firstSeen ?? now,
        os: selfConfig.os,
        hostname: selfConfig.hostname,
      }
      // 更新内存中的 self 条目（但不触发持久化，因为频繁刷新 lastSeen 没意义）
      machines.set(selfConfig.machineId, selfEntry)
      result.push(selfEntry)
    }

    // 添加所有其他机器
    for (const [id, machine] of machines.entries()) {
      if (selfConfig && id === selfConfig.machineId) continue
      result.push(machine)
    }

    // 按 name 排序（self 条目也参与排序）
    result.sort((a, b) => a.name.localeCompare(b.name))

    return result
  }

  // -------------------------------------------------------------------------
  // getMachine()
  // -------------------------------------------------------------------------

  function getMachine(machineId: string): MachineState | undefined {
    return machines.get(machineId)
  }

  // -------------------------------------------------------------------------
  // close()
  // -------------------------------------------------------------------------

  async function close(): Promise<void> {
    clearInterval(sweepTimer)

    if (persistTimer !== null) {
      clearTimeout(persistTimer)
      persistTimer = null
      // 立即执行未完成的写入
      persistPromise = flushPersist()
    }

    // 等待任何正在进行的写入完成
    await persistPromise
  }

  // -------------------------------------------------------------------------
  // Return the manager object
  // -------------------------------------------------------------------------

  return {
    register,
    heartbeat,
    listMachines,
    getMachine,
    close,
  }
}
