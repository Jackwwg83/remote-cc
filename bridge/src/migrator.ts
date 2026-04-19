/**
 * migrator.ts — Cold session migration (Server role).
 *
 * Moves a session's state from one machine in the cluster to another by:
 *   1. Verifying the source session is idle (not mid-run) via cluster state
 *   2. Stopping the session on the source if still running
 *   3. Optionally rsync'ing the project cwd to the target
 *   4. scp-ing the .jsonl session transcript to the target's
 *      ~/.claude/projects/{cwd-hash}/
 *   5. Issuing a POST /cluster/action { action: start_session, sessionId }
 *      against the target so the session resumes live
 *
 * Everything runs as child processes on the server host, so rsync and ssh
 * must be installed + configured with passwordless auth between machines
 * (standard Tailscale SSH setup).
 *
 * This is intentionally a pure-orchestration module — it does NOT own
 * cluster state; it reads from a ClusterManager snapshot and writes back
 * via forwardAction on the proxy. Makes it trivially unit-testable by
 * mocking spawn + proxy.
 */

import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { ClusterManager } from './clusterManager.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MigrateRequest {
  fromMachineId: string
  toMachineId: string
  sessionId: string
}

export interface MigrateResult {
  ok: boolean
  error?: string
  /** Human-readable progress trail for logging / UI display */
  steps: string[]
}

export interface MigratorDeps {
  cluster: ClusterManager
  /** Spawn impl for tests. Must return an EventEmitter-like with 'exit'. */
  spawnImpl?: typeof spawn
  /** fetch impl for start_session POST after migration. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Cluster token used to authenticate the final start_session call. */
  clusterToken: string
  /** Server's own base URL — used to POST /cluster/action. */
  selfServerUrl: string
  /** Override paths for unit tests. */
  rsyncBin?: string
  scpBin?: string
  /** SSH target host form: e.g. "user@mac-mini-b". Deduced from machine hostname if absent. */
  sshHost?: (machineId: string) => string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Claude Code's cwd hash (md5 of the absolute path, per CLI convention). */
export function cwdHash(cwd: string): string {
  return createHash('md5').update(cwd).digest('hex')
}

/**
 * Validate a cwd before interpolating into rsync/scp arguments. The
 * remote shell splits on spaces and interprets metacharacters, so a
 * cwd supplied by a cluster-token holder could inject commands if we
 * didn't constrain it. Policy:
 *   - must be an absolute POSIX path ('/foo' or '/Users/...')
 *   - may contain alphanumerics, '_', '-', '.', '/' only
 *   - no shell metacharacters, no whitespace, no '..' segments
 * This is intentionally stricter than what a filesystem accepts —
 * ergonomic paths universally fit.
 */
export class UnsafePathError extends Error {
  constructor(public readonly path: string, reason: string) {
    super(`Unsafe path "${path}": ${reason}`)
    this.name = 'UnsafePathError'
  }
}

const SAFE_PATH_RE = /^\/[A-Za-z0-9_./-]+$/

export function assertSafePath(p: string): void {
  if (typeof p !== 'string' || p.length === 0) {
    throw new UnsafePathError(p, 'empty')
  }
  if (!SAFE_PATH_RE.test(p)) {
    throw new UnsafePathError(p, 'contains disallowed characters (allowed: A-Za-z0-9 _ . / -)')
  }
  if (p.split('/').some((seg) => seg === '..')) {
    throw new UnsafePathError(p, 'path traversal segment ".."')
  }
}

/** Validate + shell-single-quote a string safely. Only used for defense in
 *  depth — assertSafePath already ensures no metacharacters slip through. */
export function shellQuote(s: string): string {
  // Single-quote everything; inside single quotes nothing is special except
  // the closing single quote itself, handled by '\''.
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function runCommand(
  spawnImpl: typeof spawn,
  bin: string,
  args: string[],
  opts: SpawnOptions = {},
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = ''
    const child = spawnImpl(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], ...opts })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', () => resolve({ code: -1, stderr: `spawn failed: ${bin}` }))
    child.on('exit', (code) => resolve({ code: code ?? -1, stderr: stderr.slice(0, 2000) }))
  })
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMigrator(deps: MigratorDeps) {
  const {
    cluster,
    spawnImpl = spawn,
    fetchImpl = fetch,
    clusterToken,
    selfServerUrl,
    rsyncBin = 'rsync',
    scpBin = 'scp',
  } = deps

  /** Default ssh-host mapper: use the stored hostname, fall back to machine name. */
  const sshHost = deps.sshHost ?? ((machineId: string) => {
    const m = cluster.getMachine(machineId)
    return m?.hostname ?? m?.name ?? machineId
  })

  async function migrate(req: MigrateRequest): Promise<MigrateResult> {
    const steps: string[] = []

    // --- 1. Validate both machines exist + online ---
    const src = cluster.getMachine(req.fromMachineId)
    const dst = cluster.getMachine(req.toMachineId)
    if (!src) return { ok: false, error: `unknown source machine ${req.fromMachineId}`, steps }
    if (!dst) return { ok: false, error: `unknown target machine ${req.toMachineId}`, steps }
    if (src.status === 'offline') return { ok: false, error: `source ${src.name} is offline`, steps }
    if (dst.status === 'offline') return { ok: false, error: `target ${dst.name} is offline`, steps }

    // --- 2. Find the session record on source ---
    const session = (src.sessions ?? []).find((s) => s.id === req.sessionId)
    if (!session) {
      return { ok: false, error: `session ${req.sessionId} not found on source`, steps }
    }
    const cwd = session.cwd
    // SECURITY: cwd is interpolated into remote-shell arguments for rsync/scp.
    // A cluster-token holder could otherwise choose metacharacters to break
    // migration or run arbitrary commands on the source/target via ssh.
    try {
      assertSafePath(cwd)
    } catch (err) {
      return { ok: false, error: `unsafe source cwd: ${(err as Error).message}`, steps }
    }
    const hash = cwdHash(cwd)
    steps.push(`Resolved session ${req.sessionId} at ${cwd} (cwd hash ${hash})`)

    // --- 3. Cold-migration guard: if the session is still touching state on
    // the source we must stop it before copying transcripts/code. 'running',
    // 'spawning', and 'stopping' all mean the child process is live; only
    // 'idle' and 'offline' (handled above) are safe. ---
    const liveStates = new Set(['running', 'spawning', 'stopping'])
    if (src.sessionId === req.sessionId && liveStates.has(src.status)) {
      steps.push(`Source state is '${src.status}' for this session — stopping it first (cold migration guard)`)
      try {
        const stopRes = await fetchImpl(`${selfServerUrl}/cluster/action`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${clusterToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ machineId: src.machineId, action: 'stop_session' }),
        })
        if (!stopRes.ok) {
          return { ok: false, error: `failed to stop source session: HTTP ${stopRes.status}`, steps }
        }
      } catch (err) {
        return { ok: false, error: `stop source failed: ${(err as Error).message}`, steps }
      }
    }

    // --- 4. rsync project cwd (non-fatal if it fails — caller may have
    //        intentionally placed the code on target already) ---
    const srcSsh = sshHost(src.machineId)
    const dstSsh = sshHost(dst.machineId)
    // assertSafePath above + the restricted charset in cwdHash (hex only)
    // keep these args free of shell metacharacters; we still single-quote
    // the path portion as defense in depth.
    const rsyncSrc = `${srcSsh}:${shellQuote(cwd + '/')}`
    const rsyncDst = `${dstSsh}:${shellQuote(cwd + '/')}`
    steps.push(`rsync ${rsyncSrc} → ${rsyncDst}`)
    const rsyncRes = await runCommand(spawnImpl, rsyncBin, [
      '-az', '--delete', '--exclude=.git', '--exclude=node_modules', rsyncSrc, rsyncDst,
    ])
    if (rsyncRes.code !== 0) {
      steps.push(`rsync warning (exit ${rsyncRes.code}): ${rsyncRes.stderr.slice(0, 200)}`)
      // Non-fatal — project code may already exist on target.
    }

    // --- 5. scp the .jsonl session file ---
    const jsonlRelPath = `.claude/projects/${hash}/${req.sessionId}.jsonl`
    // sessionId format is validated by the caller (Claude UUIDs), and hash is
    // hex — but still quote for defense in depth.
    const srcJsonl = `${srcSsh}:${shellQuote('$HOME/' + jsonlRelPath)}`
    const dstJsonlDir = `$HOME/.claude/projects/${hash}/`
    steps.push(`scp ${srcJsonl} → ${dstSsh}:${dstJsonlDir}`)
    // We first ensure the target dir exists via ssh mkdir -p
    const mkdirRes = await runCommand(spawnImpl, 'ssh', [dstSsh, `mkdir -p ${shellQuote(dstJsonlDir)}`])
    if (mkdirRes.code !== 0) {
      return {
        ok: false,
        error: `ssh mkdir on target failed (exit ${mkdirRes.code}): ${mkdirRes.stderr.slice(0, 200)}`,
        steps,
      }
    }
    // Use scp with -3 to route source→target via this host (server)
    const scpRes = await runCommand(spawnImpl, scpBin, [
      '-3', srcJsonl, `${dstSsh}:${shellQuote(dstJsonlDir)}`,
    ])
    if (scpRes.code !== 0) {
      return {
        ok: false,
        error: `scp failed (exit ${scpRes.code}): ${scpRes.stderr.slice(0, 200)}`,
        steps,
      }
    }

    // --- 6. Launch the session on the target via proxy ---
    steps.push(`Launching session on ${dst.name} via /cluster/action`)
    try {
      const startRes = await fetchImpl(`${selfServerUrl}/cluster/action`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${clusterToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          machineId: dst.machineId,
          action: 'start_session',
          sessionId: req.sessionId,
          cwd,
        }),
      })
      if (!startRes.ok) {
        const detail = await startRes.text().catch(() => '')
        return {
          ok: false,
          error: `start on target failed: HTTP ${startRes.status} ${detail.slice(0, 200)}`,
          steps,
        }
      }
    } catch (err) {
      return { ok: false, error: `start on target network error: ${(err as Error).message}`, steps }
    }

    steps.push(`Migration complete`)
    return { ok: true, steps }
  }

  return { migrate }
}

export type Migrator = ReturnType<typeof createMigrator>
