/**
 * Tests for auth.ts — token generation and WebSocket authentication
 *
 * Strategy:
 * - Test generateToken() format and uniqueness
 * - Test createVerifyClient() with correct/incorrect/missing tokens
 * - Integration test: WS server with verifyClient rejects unauthorized connections
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import WebSocket from 'ws'
import { generateToken, createVerifyClient } from '../src/auth.js'
import { createWsServer, type WsServer } from '../src/wsServer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tick(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Tests: generateToken
// ---------------------------------------------------------------------------

describe('generateToken', () => {
  it('should return a string starting with rcc_', () => {
    const token = generateToken()
    expect(token.startsWith('rcc_')).toBe(true)
  })

  it('should have the correct length (rcc_ + 43 base64url chars)', () => {
    const token = generateToken()
    // 32 bytes → 43 base64url chars (no padding)
    expect(token.length).toBe(4 + 43)
  })

  it('should only contain valid base64url characters after prefix', () => {
    const token = generateToken()
    const payload = token.slice(4)
    // base64url: A-Z, a-z, 0-9, -, _
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('should generate unique tokens on each call', () => {
    const tokens = new Set<string>()
    for (let i = 0; i < 100; i++) {
      tokens.add(generateToken())
    }
    expect(tokens.size).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// Tests: createVerifyClient
// ---------------------------------------------------------------------------

describe('createVerifyClient', () => {
  const token = 'rcc_test-token-abc123'

  it('should accept a valid Bearer token', () => {
    const verifyClient = createVerifyClient(token)
    const req = { headers: { authorization: `Bearer ${token}` } } as any

    let accepted: boolean | undefined
    let statusCode: number | undefined

    verifyClient({ req }, (result, code) => {
      accepted = result
      statusCode = code
    })

    expect(accepted).toBe(true)
    expect(statusCode).toBeUndefined()
  })

  it('should reject a missing Authorization header', () => {
    const verifyClient = createVerifyClient(token)
    const req = { headers: {} } as any

    let accepted: boolean | undefined
    let statusCode: number | undefined
    let message: string | undefined

    verifyClient({ req }, (result, code, msg) => {
      accepted = result
      statusCode = code
      message = msg
    })

    expect(accepted).toBe(false)
    expect(statusCode).toBe(401)
    expect(message).toBe('Unauthorized')
  })

  it('should reject an incorrect token', () => {
    const verifyClient = createVerifyClient(token)
    const req = { headers: { authorization: 'Bearer wrong-token' } } as any

    let accepted: boolean | undefined
    let statusCode: number | undefined

    verifyClient({ req }, (result, code) => {
      accepted = result
      statusCode = code
    })

    expect(accepted).toBe(false)
    expect(statusCode).toBe(401)
  })

  it('should reject a malformed Authorization header (no Bearer prefix)', () => {
    const verifyClient = createVerifyClient(token)
    const req = { headers: { authorization: token } } as any

    let accepted: boolean | undefined
    let statusCode: number | undefined

    verifyClient({ req }, (result, code) => {
      accepted = result
      statusCode = code
    })

    expect(accepted).toBe(false)
    expect(statusCode).toBe(401)
  })

  it('should reject Basic auth scheme', () => {
    const verifyClient = createVerifyClient(token)
    const req = { headers: { authorization: `Basic ${token}` } } as any

    let accepted: boolean | undefined
    let statusCode: number | undefined

    verifyClient({ req }, (result, code) => {
      accepted = result
      statusCode = code
    })

    expect(accepted).toBe(false)
    expect(statusCode).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Tests: Integration with WsServer
// ---------------------------------------------------------------------------

describe('auth + wsServer integration', () => {
  let httpServer: HttpServer
  let wsServer: WsServer
  const openClients: WebSocket[] = []

  afterEach(async () => {
    for (const ws of openClients) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    }
    openClients.length = 0

    if (wsServer) wsServer.close()
    await new Promise<void>((resolve) => {
      if (httpServer) {
        httpServer.close(() => resolve())
      } else {
        resolve()
      }
    })
  })

  function createTestServer(token: string): Promise<{
    httpServer: HttpServer
    wsServer: WsServer
    port: number
    url: string
  }> {
    return new Promise((resolve) => {
      const http = createServer()
      const ws = createWsServer(http, {
        verifyClient: createVerifyClient(token),
      })

      http.listen(0, '127.0.0.1', () => {
        const addr = http.address()
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0
        resolve({
          httpServer: http,
          wsServer: ws,
          port,
          url: `ws://127.0.0.1:${port}`,
        })
      })
    })
  }

  it('should accept connection with valid token in Authorization header', async () => {
    const token = 'rcc_valid-test-token'
    const env = await createTestServer(token)
    httpServer = env.httpServer
    wsServer = env.wsServer

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket(env.url, {
        headers: { Authorization: `Bearer ${token}` },
      })
      client.on('open', () => resolve(client))
      client.on('error', reject)
    })
    openClients.push(ws)

    await tick()
    expect(wsServer.clientCount()).toBe(1)
  })

  it('should reject connection with no Authorization header', async () => {
    const token = 'rcc_valid-test-token'
    const env = await createTestServer(token)
    httpServer = env.httpServer
    wsServer = env.wsServer

    const result = await new Promise<'error' | 'open'>((resolve) => {
      const client = new WebSocket(env.url)
      client.on('open', () => {
        openClients.push(client)
        resolve('open')
      })
      client.on('error', () => resolve('error'))
    })

    expect(result).toBe('error')
    expect(wsServer.clientCount()).toBe(0)
  })

  it('should reject connection with wrong token', async () => {
    const token = 'rcc_valid-test-token'
    const env = await createTestServer(token)
    httpServer = env.httpServer
    wsServer = env.wsServer

    const result = await new Promise<'error' | 'open'>((resolve) => {
      const client = new WebSocket(env.url, {
        headers: { Authorization: 'Bearer rcc_wrong-token' },
      })
      client.on('open', () => {
        openClients.push(client)
        resolve('open')
      })
      client.on('error', () => resolve('error'))
    })

    expect(result).toBe('error')
    expect(wsServer.clientCount()).toBe(0)
  })

  it('should allow message exchange after authenticated connection', async () => {
    const token = 'rcc_valid-test-token'
    const env = await createTestServer(token)
    httpServer = env.httpServer
    wsServer = env.wsServer

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket(env.url, {
        headers: { Authorization: `Bearer ${token}` },
      })
      client.on('open', () => resolve(client))
      client.on('error', reject)
    })
    openClients.push(ws)

    await tick()

    // Test broadcast
    const msgPromise = new Promise<string>((resolve) => {
      ws.on('message', (data) => resolve(data.toString('utf8')))
    })
    wsServer.broadcast('hello-auth')
    const received = await msgPromise
    expect(received).toBe('hello-auth')

    // Test client → server
    const serverReceived: string[] = []
    wsServer.onMessage((data) => serverReceived.push(data))
    ws.send('from-client')
    await tick()
    expect(serverReceived).toContain('from-client')
  })
})
