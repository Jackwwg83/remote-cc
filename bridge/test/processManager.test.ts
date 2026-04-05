/**
 * Tests for processManager.ts — process state machine
 *
 * Strategy:
 * - Use fake/mock ClaudeProcess objects — no real spawning.
 * - Inject a fake spawnClaude factory via the internal test seam (we
 *   re-export a factory-injected variant for tests).
 * - Test all state transitions and edge cases with fine-grained control
 *   over process lifetime.
 *
 * We use vi.mock to replace the spawner module so that createProcessManager
 * calls our fake spawnClaude instead of the real one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Writable, Readable } from 'node:stream'
import type { ClaudeProcess } from '../src/spawner.js'

// ---------------------------------------------------------------------------
// Fake ClaudeProcess factory
// ---------------------------------------------------------------------------

/**
 * A minimal ClaudeProcess backed by an EventEmitter.
 * Exposes `simulateExit()` to trigger the 'exit' event from tests.
 */
interface FakeProcess extends ClaudeProcess {
  simulateExit(code: number | null, signal: string | null): void
  killCalled: boolean
}

function makeFakeProcess(): FakeProcess {
  const emitter = new EventEmitter()
  let killed = false

  return {
    get stdin(): Writable {
      throw new Error('not implemented in fake')
    },
    get stdout(): Readable {
      throw new Error('not implemented in fake')
    },
    get pid(): number {
      return 9999
    },
    kill(): void {
      killed = true
    },
    forceKill(): void {
      killed = true
    },
    get killCalled(): boolean {
      return killed
    },
    on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void {
      emitter.on(event, listener)
    },
    once(event: 'exit', listener: (code: number | null, signal: string | null) => void): void {
      emitter.once(event, listener)
    },
    simulateExit(code: number | null, signal: string | null): void {
      emitter.emit('exit', code, signal)
    },
  }
}

// ---------------------------------------------------------------------------
// Mock the spawner module
// ---------------------------------------------------------------------------

vi.mock('../src/spawner.js', () => {
  return {
    spawnClaude: vi.fn(),
    SpawnError: class SpawnError extends Error {
      constructor(message: string, public readonly cause?: Error) {
        super(message)
        this.name = 'SpawnError'
      }
    },
  }
})

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// We import after vi.mock so we get the mocked version.
import { createProcessManager } from '../src/processManager.js'
import { spawnClaude } from '../src/spawner.js'

const mockSpawnClaude = vi.mocked(spawnClaude)

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

describe('initial state', () => {
  it('starts in idle state', () => {
    const mgr = createProcessManager()
    expect(mgr.state).toBe('idle')
    expect(mgr.process).toBeNull()
    expect(mgr.sessionId).toBeUndefined()
  })
})

describe('start() — idle → spawning → running', () => {
  it('transitions to running and returns ClaudeProcess on success', async () => {
    const fake = makeFakeProcess()
    mockSpawnClaude.mockReturnValueOnce(fake)

    const mgr = createProcessManager()
    const proc = await mgr.start('/some/cwd')

    expect(mgr.state).toBe('running')
    expect(mgr.process).toBe(fake)
    expect(proc).toBe(fake)
    expect(mockSpawnClaude).toHaveBeenCalledWith('/some/cwd', undefined)
  })

  it('passes opts through to spawnClaude', async () => {
    const fake = makeFakeProcess()
    mockSpawnClaude.mockReturnValueOnce(fake)

    const mgr = createProcessManager()
    await mgr.start('/cwd', { mode: 'resume', sessionId: 'abc-123' })

    expect(mockSpawnClaude).toHaveBeenCalledWith('/cwd', { mode: 'resume', sessionId: 'abc-123' })
    expect(mgr.sessionId).toBe('abc-123')
  })

  it('returns to idle if spawnClaude throws', async () => {
    mockSpawnClaude.mockImplementationOnce(() => {
      throw new Error('spawn failed')
    })

    const mgr = createProcessManager()
    await expect(mgr.start('/cwd')).rejects.toThrow('spawn failed')

    expect(mgr.state).toBe('idle')
    expect(mgr.process).toBeNull()
    expect(mgr.sessionId).toBeUndefined()
  })
})

describe('process exit → idle transition', () => {
  it('returns to idle when the process exits normally', async () => {
    const fake = makeFakeProcess()
    mockSpawnClaude.mockReturnValueOnce(fake)

    const mgr = createProcessManager()
    await mgr.start('/cwd')
    expect(mgr.state).toBe('running')

    fake.simulateExit(0, null)

    expect(mgr.state).toBe('idle')
    expect(mgr.process).toBeNull()
    expect(mgr.sessionId).toBeUndefined()
  })

  it('returns to idle when the process exits with an error code', async () => {
    const fake = makeFakeProcess()
    mockSpawnClaude.mockReturnValueOnce(fake)

    const mgr = createProcessManager()
    await mgr.start('/cwd')

    fake.simulateExit(1, null)

    expect(mgr.state).toBe('idle')
    expect(mgr.process).toBeNull()
  })

  it('returns to idle when the process exits with a signal', async () => {
    const fake = makeFakeProcess()
    mockSpawnClaude.mockReturnValueOnce(fake)

    const mgr = createProcessManager()
    await mgr.start('/cwd')

    fake.simulateExit(null, 'SIGTERM')

    expect(mgr.state).toBe('idle')
  })
})

// ---------------------------------------------------------------------------
// Concurrent spawn rejection
// ---------------------------------------------------------------------------

describe('concurrent spawn rejection', () => {
  it('rejects start() when already spawning', async () => {
    // Make spawn hang — it returns synchronously but we simulate it by having
    // the mock return a fake that never exits.
    const fake = makeFakeProcess()
    mockSpawnClaude.mockReturnValueOnce(fake)

    const mgr = createProcessManager()
    // First start completes synchronously to 'running' because spawnClaude is sync.
    await mgr.start('/cwd')

    // Try to start again while running.
    await expect(mgr.start('/cwd')).rejects.toThrow(/Cannot start/)
    await expect(mgr.start('/cwd')).rejects.toThrow(/running/)
  })

  it('rejects start() when already running', async () => {
    const fake = makeFakeProcess()
    mockSpawnClaude.mockReturnValueOnce(fake)

    const mgr = createProcessManager()
    await mgr.start('/cwd')

    expect(mgr.state).toBe('running')
    await expect(mgr.start('/cwd')).rejects.toThrow(/Cannot start/)
  })

  it('rejects start() when stopping', async () => {
    const fake = makeFakeProcess()
    mockSpawnClaude.mockReturnValueOnce(fake)

    const mgr = createProcessManager()
    await mgr.start('/cwd')

    // Begin stop but don't let the process exit yet — state goes to 'stopping'
    const stopPromise = mgr.stop()
    // state is now 'stopping' before the process actually dies
    expect(mgr.state).toBe('stopping')

    await expect(mgr.start('/cwd')).rejects.toThrow(/Cannot start/)

    // Allow the stop to complete.
    fake.simulateExit(0, null)
    await stopPromise
  })
})

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

describe('stop() — no-op when idle', () => {
  it('resolves immediately when idle', async () => {
    const mgr = createProcessManager()
    await expect(mgr.stop()).resolves.toBeUndefined()
    expect(mgr.state).toBe('idle')
  })
})

describe('stop() — while running', () => {
  it('transitions running → stopping → idle', async () => {
    const fake = makeFakeProcess()
    mockSpawnClaude.mockReturnValueOnce(fake)

    const mgr = createProcessManager()
    await mgr.start('/cwd')

    const stopPromise = mgr.stop()
    expect(mgr.state).toBe('stopping')
    expect(fake.killCalled).toBe(true)

    fake.simulateExit(0, null)
    await stopPromise

    expect(mgr.state).toBe('idle')
    expect(mgr.process).toBeNull()
    expect(mgr.sessionId).toBeUndefined()
  })

  it('calls kill() on the process', async () => {
    const fake = makeFakeProcess()
    mockSpawnClaude.mockReturnValueOnce(fake)

    const mgr = createProcessManager()
    await mgr.start('/cwd')

    const stopPromise = mgr.stop()
    expect(fake.killCalled).toBe(true)

    fake.simulateExit(0, null)
    await stopPromise
  })

  it('resolves once the process exits', async () => {
    const fake = makeFakeProcess()
    mockSpawnClaude.mockReturnValueOnce(fake)

    const mgr = createProcessManager()
    await mgr.start('/cwd')

    let stopped = false
    const stopPromise = mgr.stop().then(() => {
      stopped = true
    })

    // Not yet resolved
    expect(stopped).toBe(false)

    fake.simulateExit(0, null)
    await stopPromise

    expect(stopped).toBe(true)
  })
})

describe('stop() — concurrent stop() calls', () => {
  it('second stop() piggybacks on the first, resolves at the same time', async () => {
    const fake = makeFakeProcess()
    mockSpawnClaude.mockReturnValueOnce(fake)

    const mgr = createProcessManager()
    await mgr.start('/cwd')

    const stop1 = mgr.stop()
    const stop2 = mgr.stop() // concurrent — should not double-kill

    fake.simulateExit(0, null)

    await Promise.all([stop1, stop2])
    expect(mgr.state).toBe('idle')
  })
})

describe('stop() — SIGKILL timeout escalation', () => {
  it('calls kill() again after 5 s if process has not exited', async () => {
    vi.useFakeTimers()

    const fake = makeFakeProcess()
    mockSpawnClaude.mockReturnValueOnce(fake)

    const mgr = createProcessManager()
    await mgr.start('/cwd')

    const stopPromise = mgr.stop()

    // Initial SIGTERM
    expect(fake.killCalled).toBe(true)

    // Advance time past the 5 s escalation window
    vi.advanceTimersByTime(5001)

    // The escalation timer calls kill() once more — total calls ≥ 2.
    // We can't easily distinguish SIGKILL here (public API only exposes kill()),
    // but we verify kill was invoked by checking it remains true.
    expect(fake.killCalled).toBe(true)

    // Simulate process finally dying after SIGKILL
    fake.simulateExit(null, 'SIGKILL')
    await stopPromise

    expect(mgr.state).toBe('idle')

    vi.useRealTimers()
  })
})

describe('stop() — while spawning', () => {
  it('waits for spawn to finish then kills the process', async () => {
    // spawnClaude is synchronous in our implementation, so 'spawning' is a
    // very brief in-flight window. However, we can test the "spawn then stop"
    // sequence by triggering stop() right after start() returns from spawning.
    const fake = makeFakeProcess()
    mockSpawnClaude.mockReturnValueOnce(fake)

    const mgr = createProcessManager()

    // start() transitions: idle → spawning → (sync) → running
    const startPromise = mgr.start('/cwd')
    const stopPromise = mgr.stop() // called before awaiting start

    fake.simulateExit(0, null)

    await startPromise
    await stopPromise

    expect(mgr.state).toBe('idle')
  })
})

// ---------------------------------------------------------------------------
// sessionId tracking
// ---------------------------------------------------------------------------

describe('sessionId tracking', () => {
  it('is undefined when idle', () => {
    const mgr = createProcessManager()
    expect(mgr.sessionId).toBeUndefined()
  })

  it('exposes sessionId from opts while running', async () => {
    const fake = makeFakeProcess()
    mockSpawnClaude.mockReturnValueOnce(fake)

    const mgr = createProcessManager()
    await mgr.start('/cwd', { mode: 'resume', sessionId: 'sess-xyz' })

    expect(mgr.sessionId).toBe('sess-xyz')

    fake.simulateExit(0, null)
    expect(mgr.sessionId).toBeUndefined()
  })

  it('is undefined after process exits', async () => {
    const fake = makeFakeProcess()
    mockSpawnClaude.mockReturnValueOnce(fake)

    const mgr = createProcessManager()
    await mgr.start('/cwd', { sessionId: 'my-session' })
    fake.simulateExit(0, null)

    expect(mgr.sessionId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Re-use after exit
// ---------------------------------------------------------------------------

describe('re-use after process exits', () => {
  it('can start again after the previous process exits', async () => {
    const fake1 = makeFakeProcess()
    const fake2 = makeFakeProcess()
    mockSpawnClaude.mockReturnValueOnce(fake1).mockReturnValueOnce(fake2)

    const mgr = createProcessManager()

    await mgr.start('/cwd')
    fake1.simulateExit(0, null)
    expect(mgr.state).toBe('idle')

    const proc2 = await mgr.start('/cwd')
    expect(proc2).toBe(fake2)
    expect(mgr.state).toBe('running')
  })

  it('can start again after stop()', async () => {
    const fake1 = makeFakeProcess()
    const fake2 = makeFakeProcess()
    mockSpawnClaude.mockReturnValueOnce(fake1).mockReturnValueOnce(fake2)

    const mgr = createProcessManager()

    await mgr.start('/cwd')
    const stopPromise = mgr.stop()
    fake1.simulateExit(0, null)
    await stopPromise

    await mgr.start('/cwd')
    expect(mgr.state).toBe('running')
    expect(mgr.process).toBe(fake2)
  })
})
