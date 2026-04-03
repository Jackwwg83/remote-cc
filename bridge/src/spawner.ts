/**
 * spawner.ts — Spawn and manage a claude child process.
 *
 * The bridge communicates with claude via stdin/stdout using the
 * stream-json protocol. This module handles:
 * - Spawning the claude process with correct flags and env
 * - Exposing stdin/stdout streams for the line reader / writer
 * - Process lifecycle: exit events, kill, signal forwarding
 * - Spawn failure detection (claude not in PATH)
 */

import { type ChildProcess, spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeProcess {
  /** Writable stream — send stream-json messages to claude */
  readonly stdin: Writable
  /** Readable stream — receive stream-json messages from claude */
  readonly stdout: Readable
  /** Send SIGTERM to the child process */
  kill(): void
  /** Listen for exit events */
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void
  /** Listen once for exit events */
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): void
  /** The underlying child process pid (undefined if spawn failed before pid assigned) */
  readonly pid: number | undefined
}

export class SpawnError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message)
    this.name = 'SpawnError'
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_ARGS = [
  '--print',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--include-hook-events',
  '--replay-user-messages',
] as const

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class ClaudeProcessImpl extends EventEmitter implements ClaudeProcess {
  private readonly child: ChildProcess

  constructor(child: ChildProcess) {
    super()
    this.child = child

    // Forward close event as 'exit'
    child.on('close', (code, signal) => {
      this.emit('exit', code, signal)
    })

    // Spawn-level errors (e.g. ENOENT after spawn returns) also emit 'exit'
    child.on('error', (err) => {
      // 'error' fires before 'close' for ENOENT; emit exit with code 1
      // so callers see a single consistent event.
      // Note: 'close' may still fire after 'error'. We let both through;
      // callers should be prepared for multiple 'exit' events or use `once`.
      this.emit('exit', 1, null)
    })
  }

  get stdin(): Writable {
    if (!this.child.stdin) {
      throw new SpawnError('child stdin not available — stdio misconfigured')
    }
    return this.child.stdin
  }

  get stdout(): Readable {
    if (!this.child.stdout) {
      throw new SpawnError('child stdout not available — stdio misconfigured')
    }
    return this.child.stdout
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  kill(): void {
    if (!this.child.killed) {
      this.child.kill('SIGTERM')
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SpawnClaudeOptions {
  /** Override the command name (default: 'claude'). Useful for testing. */
  command?: string
  /** Extra CLI arguments appended after the default flags. */
  extraArgs?: string[]
  /** Extra environment variables merged into the child env. */
  extraEnv?: Record<string, string>
  /**
   * Replace the default CLAUDE_ARGS entirely. When set, only these args
   * (plus extraArgs) are used. Intended for testing with non-claude commands.
   * @internal
   */
  _rawArgs?: string[]
}

/**
 * Spawn a claude process configured for stream-json communication.
 *
 * @param cwd - Working directory for the child process
 * @param opts - Optional overrides (command name, extra args/env)
 * @returns A ClaudeProcess handle
 * @throws SpawnError if the spawn call itself fails synchronously
 */
export function spawnClaude(cwd: string, opts?: SpawnClaudeOptions): ClaudeProcess {
  const command = opts?.command ?? 'claude'
  const baseArgs = opts?._rawArgs ?? [...CLAUDE_ARGS]
  const args = [...baseArgs, ...(opts?.extraArgs ?? [])]

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODE_ENVIRONMENT_KIND: 'bridge',
    ...opts?.extraEnv,
  }

  let child: ChildProcess
  try {
    child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    })
  } catch (err) {
    throw new SpawnError(
      `Failed to spawn "${command}": ${(err as Error).message}`,
      err as Error,
    )
  }

  // Forward SIGTERM/SIGINT from bridge to child
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (child && !child.killed) {
      child.kill(signal)
    }
  }

  const onSigterm = () => forwardSignal('SIGTERM')
  const onSigint = () => forwardSignal('SIGINT')

  process.on('SIGTERM', onSigterm)
  process.on('SIGINT', onSigint)

  // Clean up signal listeners when child exits
  child.on('close', () => {
    process.removeListener('SIGTERM', onSigterm)
    process.removeListener('SIGINT', onSigint)
  })

  return new ClaudeProcessImpl(child)
}
