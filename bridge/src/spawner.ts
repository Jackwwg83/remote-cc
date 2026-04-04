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

export const CLAUDE_ARGS = [
  '--print',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--permission-prompt-tool', 'stdio',
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

  constructor(child: ChildProcess, onExit?: () => void) {
    super()
    this.child = child

    // Guard against emitting 'exit' twice (ENOENT fires both 'error' and 'close')
    let exitFired = false

    // Forward close event as 'exit'
    child.on('close', (code, signal) => {
      if (!exitFired) {
        exitFired = true
        onExit?.()
        this.emit('exit', code, signal)
      }
    })

    // Spawn-level errors (e.g. ENOENT after spawn returns) also emit 'exit'
    child.on('error', (_err) => {
      if (!exitFired) {
        exitFired = true
        onExit?.()
        this.emit('exit', 1, null)
      }
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

  // Track whether we received a termination signal so we know to exit
  // after the child dies (otherwise the signal handlers suppress default
  // Node.js termination behavior and the bridge hangs).
  let receivedSignal: NodeJS.Signals | null = null

  const forwardSignal = (signal: NodeJS.Signals) => {
    receivedSignal = signal
    if (child && !child.killed) {
      child.kill(signal)
      // If child doesn't exit within 5s, escalate to SIGKILL
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL')
        }
      }, 5000).unref()
    }
  }

  const onSigterm = () => forwardSignal('SIGTERM')
  const onSigint = () => forwardSignal('SIGINT')

  process.on('SIGTERM', onSigterm)
  process.on('SIGINT', onSigint)

  // Clean up signal listeners when child exits (via onExit callback,
  // which fires from whichever of 'close' or 'error' comes first).
  // If we received a signal, re-raise it so the bridge exits with the
  // correct signal-based exit code.
  const cleanupSignals = () => {
    process.removeListener('SIGTERM', onSigterm)
    process.removeListener('SIGINT', onSigint)

    if (receivedSignal) {
      // Re-raise the signal with default handler to terminate the bridge.
      // Reset to default handler first, then re-send.
      process.kill(process.pid, receivedSignal)
    }
  }

  return new ClaudeProcessImpl(child, cleanupSignals)
}
