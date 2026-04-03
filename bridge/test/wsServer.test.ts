/**
 * Tests for wsServer.ts
 *
 * Strategy:
 * - Create a real HTTP server on a random port (port 0)
 * - Attach the WsServer to it
 * - Connect real WebSocket clients to test behavior
 * - Test: client connect, message forwarding, broadcast, disconnect,
 *   multi-client, transparent passthrough of all message types
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import WebSocket from 'ws'
import { createWsServer, type WsServer } from '../src/wsServer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an HTTP server on a random port and attach a WsServer. */
function createTestServer(): Promise<{
  httpServer: HttpServer
  wsServer: WsServer
  port: number
  url: string
}> {
  return new Promise((resolve) => {
    const httpServer = createServer()
    const wsServer = createWsServer(httpServer)

    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      resolve({
        httpServer,
        wsServer,
        port,
        url: `ws://127.0.0.1:${port}`,
      })
    })
  })
}

/** Connect a WebSocket client and wait for the connection to open. */
function connectClient(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

/** Collect the next N messages from a WebSocket client. */
function collectMessages(ws: WebSocket, count: number): Promise<string[]> {
  return new Promise((resolve) => {
    const messages: string[] = []
    const handler = (data: WebSocket.RawData) => {
      messages.push(data.toString('utf8'))
      if (messages.length >= count) {
        ws.off('message', handler)
        resolve(messages)
      }
    }
    ws.on('message', handler)
  })
}

/** Wait for a single message from a WebSocket client. */
function waitForMessage(ws: WebSocket): Promise<string> {
  return collectMessages(ws, 1).then((msgs) => msgs[0])
}

/** Wait for the client to reach CLOSED state. */
function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }
    ws.on('close', () => resolve())
  })
}

/** Small delay to let async events propagate. */
function tick(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createWsServer', () => {
  let httpServer: HttpServer
  let wsServer: WsServer
  const openClients: WebSocket[] = []

  afterEach(async () => {
    // Close all test clients
    for (const ws of openClients) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    }
    openClients.length = 0

    // Close the server
    if (wsServer) wsServer.close()
    await new Promise<void>((resolve) => {
      if (httpServer) {
        httpServer.close(() => resolve())
      } else {
        resolve()
      }
    })
  })

  /** Helper to connect and track a client for cleanup. */
  async function connect(url: string): Promise<WebSocket> {
    const ws = await connectClient(url)
    openClients.push(ws)
    return ws
  }

  // -------------------------------------------------------------------------
  // Connection tracking
  // -------------------------------------------------------------------------

  it('should start with zero clients', async () => {
    const env = await createTestServer()
    httpServer = env.httpServer
    wsServer = env.wsServer

    expect(wsServer.clientCount()).toBe(0)
  })

  it('should track a connected client', async () => {
    const env = await createTestServer()
    httpServer = env.httpServer
    wsServer = env.wsServer

    await connect(env.url)

    // Small tick to let the server-side 'connection' event propagate
    await tick()
    expect(wsServer.clientCount()).toBe(1)
  })

  it('should remove client on disconnect', async () => {
    const env = await createTestServer()
    httpServer = env.httpServer
    wsServer = env.wsServer

    const client = await connect(env.url)
    await tick()
    expect(wsServer.clientCount()).toBe(1)

    client.close()
    await waitForClose(client)
    await tick()
    expect(wsServer.clientCount()).toBe(0)
  })

  it('should track multiple clients independently', async () => {
    const env = await createTestServer()
    httpServer = env.httpServer
    wsServer = env.wsServer

    const c1 = await connect(env.url)
    const c2 = await connect(env.url)
    const c3 = await connect(env.url)
    await tick()
    expect(wsServer.clientCount()).toBe(3)

    // Disconnect one
    c2.close()
    await waitForClose(c2)
    await tick()
    expect(wsServer.clientCount()).toBe(2)

    // Disconnect another
    c1.close()
    await waitForClose(c1)
    await tick()
    expect(wsServer.clientCount()).toBe(1)

    // Last one
    c3.close()
    await waitForClose(c3)
    await tick()
    expect(wsServer.clientCount()).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Client -> Server (onMessage)
  // -------------------------------------------------------------------------

  it('should forward client messages via onMessage callback', async () => {
    const env = await createTestServer()
    httpServer = env.httpServer
    wsServer = env.wsServer

    const received: string[] = []
    wsServer.onMessage((data) => received.push(data))

    const client = await connect(env.url)
    await tick()

    const msg = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } })
    client.send(msg)
    await tick()

    expect(received).toHaveLength(1)
    expect(received[0]).toBe(msg)
  })

  it('should support multiple onMessage callbacks', async () => {
    const env = await createTestServer()
    httpServer = env.httpServer
    wsServer = env.wsServer

    const received1: string[] = []
    const received2: string[] = []
    wsServer.onMessage((data) => received1.push(data))
    wsServer.onMessage((data) => received2.push(data))

    const client = await connect(env.url)
    await tick()

    client.send('test-message')
    await tick()

    expect(received1).toEqual(['test-message'])
    expect(received2).toEqual(['test-message'])
  })

  it('should forward messages from multiple clients', async () => {
    const env = await createTestServer()
    httpServer = env.httpServer
    wsServer = env.wsServer

    const received: string[] = []
    wsServer.onMessage((data) => received.push(data))

    const c1 = await connect(env.url)
    const c2 = await connect(env.url)
    await tick()

    c1.send('from-client-1')
    c2.send('from-client-2')
    await tick()

    expect(received).toHaveLength(2)
    expect(received).toContain('from-client-1')
    expect(received).toContain('from-client-2')
  })

  // -------------------------------------------------------------------------
  // Server -> Client (broadcast)
  // -------------------------------------------------------------------------

  it('should broadcast to a single connected client', async () => {
    const env = await createTestServer()
    httpServer = env.httpServer
    wsServer = env.wsServer

    const client = await connect(env.url)
    await tick()

    const msgPromise = waitForMessage(client)
    const msg = JSON.stringify({ type: 'assistant', message: { content: 'hi' } })
    wsServer.broadcast(msg)

    const received = await msgPromise
    expect(received).toBe(msg)
  })

  it('should broadcast to all connected clients', async () => {
    const env = await createTestServer()
    httpServer = env.httpServer
    wsServer = env.wsServer

    const c1 = await connect(env.url)
    const c2 = await connect(env.url)
    const c3 = await connect(env.url)
    await tick()

    const p1 = waitForMessage(c1)
    const p2 = waitForMessage(c2)
    const p3 = waitForMessage(c3)

    wsServer.broadcast('hello-all')

    const results = await Promise.all([p1, p2, p3])
    expect(results).toEqual(['hello-all', 'hello-all', 'hello-all'])
  })

  it('should not fail when broadcasting with no clients', async () => {
    const env = await createTestServer()
    httpServer = env.httpServer
    wsServer = env.wsServer

    // Should not throw
    expect(() => wsServer.broadcast('nobody-listening')).not.toThrow()
  })

  // -------------------------------------------------------------------------
  // Transparent passthrough (no message filtering)
  // -------------------------------------------------------------------------

  it('should pass through control_request (can_use_tool) without filtering', async () => {
    const env = await createTestServer()
    httpServer = env.httpServer
    wsServer = env.wsServer

    const client = await connect(env.url)
    await tick()

    const msgPromise = waitForMessage(client)

    // Simulate claude sending a permission request — bridge just broadcasts it
    const controlRequest = JSON.stringify({
      type: 'control_request',
      request_id: 'req_001',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      },
    })
    wsServer.broadcast(controlRequest)

    const received = await msgPromise
    expect(received).toBe(controlRequest)
    // Verify it's actually parseable and untouched
    expect(JSON.parse(received)).toEqual(JSON.parse(controlRequest))
  })

  it('should pass through control_response from client without filtering', async () => {
    const env = await createTestServer()
    httpServer = env.httpServer
    wsServer = env.wsServer

    const received: string[] = []
    wsServer.onMessage((data) => received.push(data))

    const client = await connect(env.url)
    await tick()

    // Client sends a permission response — bridge passes it through
    const controlResponse = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req_001',
        response: { behavior: 'allow' },
      },
    })
    client.send(controlResponse)
    await tick()

    expect(received).toHaveLength(1)
    expect(received[0]).toBe(controlResponse)
  })

  it('should pass through unknown message types (future compatibility)', async () => {
    const env = await createTestServer()
    httpServer = env.httpServer
    wsServer = env.wsServer

    // Test broadcast of unknown type
    const client = await connect(env.url)
    await tick()

    const msgPromise = waitForMessage(client)
    const futureMsg = JSON.stringify({ type: 'future_unknown_type', data: { foo: 'bar' } })
    wsServer.broadcast(futureMsg)

    const received = await msgPromise
    expect(received).toBe(futureMsg)

    // Test client sending unknown type
    const serverReceived: string[] = []
    wsServer.onMessage((data) => serverReceived.push(data))

    client.send(futureMsg)
    await tick()

    expect(serverReceived).toHaveLength(1)
    expect(serverReceived[0]).toBe(futureMsg)
  })

  // -------------------------------------------------------------------------
  // Close
  // -------------------------------------------------------------------------

  it('should disconnect all clients on close()', async () => {
    const env = await createTestServer()
    httpServer = env.httpServer
    wsServer = env.wsServer

    const c1 = await connect(env.url)
    const c2 = await connect(env.url)
    await tick()
    expect(wsServer.clientCount()).toBe(2)

    const p1 = waitForClose(c1)
    const p2 = waitForClose(c2)

    wsServer.close()

    await Promise.all([p1, p2])
    expect(wsServer.clientCount()).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Binary message handling
  // -------------------------------------------------------------------------

  it('should handle Buffer messages from clients', async () => {
    const env = await createTestServer()
    httpServer = env.httpServer
    wsServer = env.wsServer

    const received: string[] = []
    wsServer.onMessage((data) => received.push(data))

    const client = await connect(env.url)
    await tick()

    // Send as Buffer
    const msg = JSON.stringify({ type: 'user', message: 'hello' })
    client.send(Buffer.from(msg, 'utf8'))
    await tick()

    expect(received).toHaveLength(1)
    expect(received[0]).toBe(msg)
  })
})
