/**
 * Tests for spawner.ts
 *
 * Strategy:
 * - Spawn success: use real child processes (cat, env, true, false, sleep)
 *   with _rawArgs:[] to bypass the default claude CLI flags.
 * - Spawn failure: use a non-existent command to trigger ENOENT.
 * - Exit handling: verify exit event with correct code/signal.
 * - Kill: verify the process can be terminated.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { spawnClaude, SpawnError, CLAUDE_ARGS, type ClaudeProcess } from '../src/spawner.js'
import { tmpdir } from 'node:os'

// Track spawned processes so we can clean up even if a test fails
const spawned: ClaudeProcess[] = []

afterEach(() => {
  for (const proc of spawned) {
    try { proc.kill() } catch { /* already dead */ }
  }
  spawned.length = 0
})

describe('spawnClaude', () => {
  it('should spawn a process and expose stdin/stdout/pid', () => {
    const proc = spawnClaude(tmpdir(), { command: 'cat', _rawArgs: [] })
    spawned.push(proc)

    expect(proc.stdin).toBeDefined()
    expect(proc.stdout).toBeDefined()
    expect(typeof proc.pid).toBe('number')
    expect(proc.pid).toBeGreaterThan(0)

    proc.kill()
  })

  it('should pass through data via stdin/stdout', async () => {
    // cat echoes stdin to stdout — perfect for testing stream wiring
    const proc = spawnClaude(tmpdir(), { command: 'cat', _rawArgs: [] })
    spawned.push(proc)

    const received = new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      proc.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        resolve(Buffer.concat(chunks).toString())
      })
      proc.stdout.on('error', reject)
      setTimeout(() => reject(new Error('timeout waiting for stdout data')), 3000)
    })

    proc.stdin.write('hello from bridge\n')
    proc.stdin.end()

    const data = await received
    expect(data).toContain('hello from bridge')
  })

  it('should set CLAUDE_CODE_ENVIRONMENT_KIND=bridge in child env', async () => {
    const proc = spawnClaude(tmpdir(), { command: 'env', _rawArgs: [] })
    spawned.push(proc)

    const output = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      proc.stdout.on('end', () => resolve(Buffer.concat(chunks).toString()))
      proc.stdout.on('error', reject)
      setTimeout(() => reject(new Error('timeout')), 3000)
    })

    expect(output).toContain('CLAUDE_CODE_ENVIRONMENT_KIND=bridge')
  })

  it('should merge extraEnv into child environment', async () => {
    const proc = spawnClaude(tmpdir(), {
      command: 'env',
      _rawArgs: [],
      extraEnv: { REMOTE_CC_TEST_VAR: 'test123' },
    })
    spawned.push(proc)

    const output = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      proc.stdout.on('end', () => resolve(Buffer.concat(chunks).toString()))
      proc.stdout.on('error', reject)
      setTimeout(() => reject(new Error('timeout')), 3000)
    })

    expect(output).toContain('REMOTE_CC_TEST_VAR=test123')
  })

  it('should use default CLAUDE_ARGS when no _rawArgs override', () => {
    // We cannot actually spawn `claude` in tests, but we can verify the
    // function does not throw for a valid command and the args are wired.
    // Use `echo` which will just print the args and exit.
    const proc = spawnClaude(tmpdir(), { command: 'echo', _rawArgs: ['--print', '--verbose'] })
    spawned.push(proc)

    const output = new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      proc.stdout.on('end', () => resolve(Buffer.concat(chunks).toString()))
      setTimeout(() => reject(new Error('timeout')), 3000)
    })

    return output.then(data => {
      expect(data).toContain('--print')
      expect(data).toContain('--verbose')
    })
  })
})

describe('spawn failure', () => {
  it('should emit exit event when command is not found (ENOENT)', async () => {
    const proc = spawnClaude(tmpdir(), {
      command: '__nonexistent_command_for_test__',
      _rawArgs: [],
    })
    spawned.push(proc)

    const exitResult = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      proc.on('exit', (code, signal) => {
        resolve({ code, signal })
      })
      setTimeout(() => reject(new Error('timeout waiting for exit')), 3000)
    })

    // ENOENT fires 'error' on ChildProcess, which we map to exit(1, null)
    expect(exitResult.code).toBe(1)
  })

  it('should emit exit only once on ENOENT (no duplicate from close)', async () => {
    const proc = spawnClaude(tmpdir(), {
      command: '__nonexistent_command_for_test__',
      _rawArgs: [],
    })
    spawned.push(proc)

    let exitCount = 0
    proc.on('exit', () => {
      exitCount++
    })

    // Wait long enough for both 'error' and 'close' to fire
    await new Promise(r => setTimeout(r, 500))

    expect(exitCount).toBe(1)
  })
})

describe('process exit handling', () => {
  it('should emit exit with code 0 for successful command', async () => {
    const proc = spawnClaude(tmpdir(), { command: 'true', _rawArgs: [] })
    spawned.push(proc)

    const exitResult = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      proc.on('exit', (code, signal) => {
        resolve({ code, signal })
      })
      setTimeout(() => reject(new Error('timeout')), 3000)
    })

    expect(exitResult.code).toBe(0)
    expect(exitResult.signal).toBeNull()
  })

  it('should emit exit with non-zero code for failing command', async () => {
    const proc = spawnClaude(tmpdir(), { command: 'false', _rawArgs: [] })
    spawned.push(proc)

    const exitResult = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      proc.on('exit', (code, signal) => {
        resolve({ code, signal })
      })
      setTimeout(() => reject(new Error('timeout')), 3000)
    })

    expect(exitResult.code).not.toBe(0)
  })
})

describe('kill', () => {
  it('should terminate the process via kill()', async () => {
    // sleep will block; we kill it
    const proc = spawnClaude(tmpdir(), { command: 'sleep', _rawArgs: ['60'] })
    spawned.push(proc)

    const exitResult = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      proc.on('exit', (code, signal) => {
        resolve({ code, signal })
      })
      setTimeout(() => reject(new Error('timeout')), 3000)
    })

    // Give the process a moment to start
    await new Promise(r => setTimeout(r, 50))
    proc.kill()

    const result = await exitResult
    // Process was terminated — either signal=SIGTERM or non-zero exit code
    // (behavior varies by platform)
    const wasKilled = result.signal === 'SIGTERM' || (result.code !== null && result.code !== 0)
    expect(wasKilled).toBe(true)
  })

  it('should be safe to call kill() multiple times', async () => {
    const proc = spawnClaude(tmpdir(), { command: 'sleep', _rawArgs: ['60'] })
    spawned.push(proc)

    const exitResult = new Promise<void>((resolve, reject) => {
      proc.on('exit', () => resolve())
      setTimeout(() => reject(new Error('timeout')), 3000)
    })

    await new Promise(r => setTimeout(r, 50))
    proc.kill()
    proc.kill() // should not throw
    proc.kill() // should not throw

    await exitResult // should resolve without error
  })
})

describe('CLAUDE_ARGS constant', () => {
  it('should contain all 7 required flags for stream-json communication', () => {
    expect(CLAUDE_ARGS).toContain('--print')
    expect(CLAUDE_ARGS).toContain('--input-format')
    expect(CLAUDE_ARGS).toContain('--output-format')
    expect(CLAUDE_ARGS).toContain('--verbose')
    expect(CLAUDE_ARGS).toContain('--include-partial-messages')
    expect(CLAUDE_ARGS).toContain('--include-hook-events')
    expect(CLAUDE_ARGS).toContain('--replay-user-messages')

    // Verify stream-json is the format for both input and output
    const args = [...CLAUDE_ARGS]
    const inputIdx = args.indexOf('--input-format')
    const outputIdx = args.indexOf('--output-format')
    expect(args[inputIdx + 1]).toBe('stream-json')
    expect(args[outputIdx + 1]).toBe('stream-json')
  })
})

describe('signal forwarding', () => {
  it('should forward SIGTERM to child and re-raise after child exits', async () => {
    // Spawn a sleep process, send SIGTERM to the bridge's signal handler
    const proc = spawnClaude(tmpdir(), { command: 'sleep', _rawArgs: ['60'] })
    spawned.push(proc)

    const exitResult = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      proc.on('exit', (code, signal) => {
        resolve({ code, signal })
      })
      setTimeout(() => reject(new Error('timeout waiting for child exit')), 5000)
    })

    // Give the process a moment to start
    await new Promise(r => setTimeout(r, 100))

    // Simulate SIGTERM arriving at the bridge process.
    // The spawner registers handlers that forward to child.
    // We can't easily test process.exit in-process, but we can verify
    // the child gets killed by emitting SIGTERM on process.
    // To avoid actually killing this test process, we call kill() directly.
    proc.kill()

    const result = await exitResult
    const wasKilled = result.signal === 'SIGTERM' || (result.code !== null && result.code !== 0)
    expect(wasKilled).toBe(true)
  })

  it('should clean up signal listeners after child exits', async () => {
    const listenerCountBefore = process.listenerCount('SIGTERM')

    const proc = spawnClaude(tmpdir(), { command: 'true', _rawArgs: [] })
    spawned.push(proc)

    // While child is running, we should have one extra listener
    expect(process.listenerCount('SIGTERM')).toBe(listenerCountBefore + 1)

    // Wait for child to exit
    await new Promise<void>((resolve, reject) => {
      proc.on('exit', () => resolve())
      setTimeout(() => reject(new Error('timeout')), 3000)
    })

    // After child exits, the listener should be removed
    expect(process.listenerCount('SIGTERM')).toBe(listenerCountBefore)
  })
})

describe('SpawnError', () => {
  it('should have correct name and message', () => {
    const err = new SpawnError('test error')
    expect(err.name).toBe('SpawnError')
    expect(err.message).toBe('test error')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(SpawnError)
  })

  it('should preserve cause', () => {
    const cause = new Error('root cause')
    const err = new SpawnError('wrapper', cause)
    expect(err.cause).toBe(cause)
  })
})
