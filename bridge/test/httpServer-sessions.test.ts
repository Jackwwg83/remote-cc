/**
 * Tests for httpServer.ts session control endpoints.
 *
 * Strategy:
 * - Start the HTTP server on port 0 (random) with mock deps
 * - Test: GET /sessions/history, POST /sessions/start, GET /sessions/status,
 *         POST /sessions/stop
 * - Verify body parsing, 400/409 error responses, and dep integration
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import { startHttpServer, type HttpServerDeps } from '../src/httpServer.js'
import type { ProcessManager, ProcessState } from '../src/processManager.js'
import type { SessionInfo } from '../src/sessionScanner.js'
import type { ClaudeProcess } from '../src/spawner.js'

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockSessionInfo(overrides?: Partial<SessionInfo>): SessionInfo {
  return {
    id: 'abc-123-def-456',
    shortId: 'abc1..f456',
    project: 'my-project',
    cwd: '/Users/test/my-project',
    time: '2026-04-01T10:00:00.000Z',
    summary: 'Hello world',
    ...overrides,
  }
}

/** Create a mock ProcessManager with controllable state. */
function makeMockProcessManager(overrides?: {
  state?: ProcessState
  sessionId?: string
  startResult?: ClaudeProcess | Error
}): ProcessManager {
  const state = overrides?.state ?? 'idle'
  const sessionId = overrides?.sessionId

  const mockProc = {
    stdin: {} as any,
    stdout: {} as any,
    kill: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    pid: 12345,
  } as unknown as ClaudeProcess

  return {
    get state() { return state },
    get sessionId() { return sessionId },
    get process() { return state === 'running' ? mockProc : null },
    start: overrides?.startResult instanceof Error
      ? vi.fn().mockRejectedValue(overrides.startResult)
      : vi.fn().mockResolvedValue(overrides?.startResult ?? mockProc),
    stop: vi.fn().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

describe('httpServer session endpoints', () => {
  let server: HttpServer | undefined
  let fetchUrl: string

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve())
      })
      server = undefined
    }
  })

  /** Start a test server with given deps. */
  async function startTest(deps?: HttpServerDeps): Promise<void> {
    const result = await startHttpServer(0, deps)
    server = result.server
    const port = new URL(result.url).port
    fetchUrl = `http://localhost:${port}`
  }

  // =========================================================================
  // GET /sessions/history
  // =========================================================================

  describe('GET /sessions/history', () => {
    it('should return { sessions: [] } when no scanSessions dep provided', async () => {
      await startTest()

      const res = await fetch(`${fetchUrl}/sessions/history`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ sessions: [] })
    })

    it('should return sessions from scanSessions', async () => {
      const session1 = makeMockSessionInfo({ id: 'aaa' })
      const session2 = makeMockSessionInfo({ id: 'bbb', time: '2026-04-02T10:00:00.000Z' })
      const scanSessions = vi.fn().mockResolvedValue([session2, session1])

      await startTest({ scanSessions })

      const res = await fetch(`${fetchUrl}/sessions/history`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.sessions).toHaveLength(2)
      expect(body.sessions[0].id).toBe('bbb')
      expect(body.sessions[1].id).toBe('aaa')
      expect(scanSessions).toHaveBeenCalledOnce()
    })

    it('should also work via GET /sessions (backward compat alias)', async () => {
      const session = makeMockSessionInfo()
      const scanSessions = vi.fn().mockResolvedValue([session])

      await startTest({ scanSessions })

      const res = await fetch(`${fetchUrl}/sessions`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.sessions).toHaveLength(1)
      expect(body.sessions[0].id).toBe(session.id)
    })
  })

  // =========================================================================
  // GET /sessions/status
  // =========================================================================

  describe('GET /sessions/status', () => {
    it('should return { state: "idle" } when no processManager', async () => {
      await startTest()

      const res = await fetch(`${fetchUrl}/sessions/status`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ state: 'idle' })
    })

    it('should return current state from processManager', async () => {
      const pm = makeMockProcessManager({ state: 'running', sessionId: 'sess-123' })
      await startTest({ processManager: pm })

      const res = await fetch(`${fetchUrl}/sessions/status`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ state: 'running', sessionId: 'sess-123' })
    })

    it('should omit sessionId when not set', async () => {
      const pm = makeMockProcessManager({ state: 'idle' })
      await startTest({ processManager: pm })

      const res = await fetch(`${fetchUrl}/sessions/status`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ state: 'idle' })
      expect(body).not.toHaveProperty('sessionId')
    })
  })

  // =========================================================================
  // POST /sessions/start
  // =========================================================================

  describe('POST /sessions/start', () => {
    it('should return 500 when no processManager injected', async () => {
      await startTest()

      const res = await fetch(`${fetchUrl}/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error).toContain('Process manager not available')
    })

    it('should start a new session with empty body', async () => {
      const pm = makeMockProcessManager()
      await startTest({ processManager: pm })

      const res = await fetch(`${fetchUrl}/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(pm.start).toHaveBeenCalledOnce()

      // Should use mode: 'new' since no sessionId provided
      const callArgs = (pm.start as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(callArgs[1]).toMatchObject({ mode: 'new' })
    })

    it('should start a resume session when sessionId provided', async () => {
      const pm = makeMockProcessManager()
      await startTest({ processManager: pm })

      const res = await fetch(`${fetchUrl}/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'my-uuid-123' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)

      const callArgs = (pm.start as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(callArgs[1]).toMatchObject({ mode: 'resume', sessionId: 'my-uuid-123' })
    })

    it('should pass cwd to processManager.start', async () => {
      const pm = makeMockProcessManager()
      await startTest({ processManager: pm })

      const res = await fetch(`${fetchUrl}/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp/my-project' }),
      })
      expect(res.status).toBe(200)

      const callArgs = (pm.start as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(callArgs[0]).toBe('/tmp/my-project')
    })

    it('should call onSessionStarted callback after successful start', async () => {
      const pm = makeMockProcessManager()
      const onSessionStarted = vi.fn()
      await startTest({ processManager: pm, onSessionStarted })

      await fetch(`${fetchUrl}/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(onSessionStarted).toHaveBeenCalledOnce()
    })

    it('should return 409 when process already running', async () => {
      const pm = makeMockProcessManager({ state: 'running', sessionId: 'existing' })
      await startTest({ processManager: pm })

      const res = await fetch(`${fetchUrl}/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toContain('running')
      expect(body.state).toBe('running')
    })

    it('should return 409 when process is spawning', async () => {
      const pm = makeMockProcessManager({ state: 'spawning' })
      await startTest({ processManager: pm })

      const res = await fetch(`${fetchUrl}/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toContain('spawning')
    })

    it('should return 400 for invalid JSON body', async () => {
      const pm = makeMockProcessManager()
      await startTest({ processManager: pm })

      const res = await fetch(`${fetchUrl}/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json{{{',
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('Invalid JSON')
    })

    it('should return 400 when body is a JSON array', async () => {
      const pm = makeMockProcessManager()
      await startTest({ processManager: pm })

      const res = await fetch(`${fetchUrl}/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([1, 2, 3]),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('Body must be a JSON object')
    })

    it('should return 400 when sessionId is not a string', async () => {
      const pm = makeMockProcessManager()
      await startTest({ processManager: pm })

      const res = await fetch(`${fetchUrl}/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 123 }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('sessionId must be a string')
    })

    it('should return 400 when cwd is not a string', async () => {
      const pm = makeMockProcessManager()
      await startTest({ processManager: pm })

      const res = await fetch(`${fetchUrl}/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: 42 }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('cwd must be a string')
    })

    it('should handle empty POST body (treated as empty object = new session)', async () => {
      const pm = makeMockProcessManager()
      await startTest({ processManager: pm })

      const res = await fetch(`${fetchUrl}/sessions/start`, {
        method: 'POST',
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
    })

    it('should return 409 when start() throws (race condition)', async () => {
      const pm = makeMockProcessManager({
        startResult: new Error('Cannot start: process manager is in \'spawning\' state.'),
      })
      await startTest({ processManager: pm })

      const res = await fetch(`${fetchUrl}/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toContain('Cannot start')
    })
  })

  // =========================================================================
  // POST /sessions/stop
  // =========================================================================

  describe('POST /sessions/stop', () => {
    it('should return { ok: true } when no processManager', async () => {
      await startTest()

      const res = await fetch(`${fetchUrl}/sessions/stop`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ ok: true })
    })

    it('should call processManager.stop() and return ok', async () => {
      const pm = makeMockProcessManager({ state: 'running' })
      await startTest({ processManager: pm })

      const res = await fetch(`${fetchUrl}/sessions/stop`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ ok: true })
      expect(pm.stop).toHaveBeenCalledOnce()
    })
  })

  // =========================================================================
  // CORS on new endpoints
  // =========================================================================

  describe('CORS on session endpoints', () => {
    it('should include CORS headers on POST responses', async () => {
      await startTest()

      const res = await fetch(`${fetchUrl}/sessions/stop`, { method: 'POST' })
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    })

    it('should include CORS headers on GET /sessions/status', async () => {
      await startTest()

      const res = await fetch(`${fetchUrl}/sessions/status`)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
    })
  })
})
