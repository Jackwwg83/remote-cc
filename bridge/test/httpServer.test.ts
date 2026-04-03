/**
 * Tests for httpServer.ts
 *
 * Strategy:
 * - Start the HTTP server on a random port (port 0)
 * - Use Node's built-in fetch (Node 18+) to make HTTP requests
 * - Test: GET /, GET /health, GET /sessions, 404, CORS headers, OPTIONS preflight
 */

import { describe, it, expect, afterEach } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import { startHttpServer } from '../src/httpServer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Small delay to let async events propagate. */
function tick(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startHttpServer', () => {
  let server: HttpServer | undefined
  let baseUrl: string

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve())
      })
      server = undefined
    }
  })

  /** Start a test server on a random port. */
  async function startTest(): Promise<void> {
    const result = await startHttpServer(0)
    server = result.server
    baseUrl = result.url
  }

  // -------------------------------------------------------------------------
  // Server startup
  // -------------------------------------------------------------------------

  it('should start and return a url', async () => {
    await startTest()
    expect(baseUrl).toMatch(/^http:\/\/localhost:\d+$/)
  })

  // -------------------------------------------------------------------------
  // GET /
  // -------------------------------------------------------------------------

  it('should return placeholder HTML on GET /', async () => {
    await startTest()

    const res = await fetch(`${baseUrl}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')

    const body = await res.text()
    expect(body).toContain('<title>remote-cc</title>')
    expect(body).toContain('Web UI coming soon')
  })

  // -------------------------------------------------------------------------
  // GET /health
  // -------------------------------------------------------------------------

  it('should return health JSON on GET /health', async () => {
    await startTest()

    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')

    const body = await res.json()
    expect(body).toEqual({ ok: true, version: '0.1.0' })
  })

  // -------------------------------------------------------------------------
  // GET /sessions
  // -------------------------------------------------------------------------

  it('should return empty array on GET /sessions', async () => {
    await startTest()

    const res = await fetch(`${baseUrl}/sessions`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')

    const body = await res.json()
    expect(body).toEqual([])
  })

  // -------------------------------------------------------------------------
  // 404
  // -------------------------------------------------------------------------

  it('should return 404 for unknown routes', async () => {
    await startTest()

    const res = await fetch(`${baseUrl}/nonexistent`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')

    const body = await res.json()
    expect(body).toEqual({ error: 'Not Found' })
  })

  it('should return 404 for POST to known GET routes', async () => {
    await startTest()

    const res = await fetch(`${baseUrl}/health`, { method: 'POST' })
    expect(res.status).toBe(404)
  })

  // -------------------------------------------------------------------------
  // CORS headers
  // -------------------------------------------------------------------------

  it('should include CORS headers on all responses', async () => {
    await startTest()

    // Check on a 200 response
    const res200 = await fetch(`${baseUrl}/health`)
    expect(res200.headers.get('access-control-allow-origin')).toBe('*')
    expect(res200.headers.get('access-control-allow-methods')).toContain('GET')

    // Check on a 404 response
    const res404 = await fetch(`${baseUrl}/nonexistent`)
    expect(res404.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('should handle OPTIONS preflight with 204', async () => {
    await startTest()

    const res = await fetch(`${baseUrl}/health`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toContain('GET')
    expect(res.headers.get('access-control-allow-headers')).toContain('Content-Type')
  })

  // -------------------------------------------------------------------------
  // HTML response
  // -------------------------------------------------------------------------

  it('should return valid HTML on GET /', async () => {
    await startTest()

    const res = await fetch(`${baseUrl}/`)
    const body = await res.text()
    expect(body).toContain('<!DOCTYPE html>')
    expect(body).toContain('<html')
    expect(body).toContain('</html>')
  })
})
