/**
 * wsServer.ts — WebSocket server for bridging web clients to claude.
 *
 * This is the core routing layer of the bridge. It:
 * - Creates a WebSocket server on top of an existing HTTP server
 * - Tracks connected clients (add on connect, remove on disconnect)
 * - Broadcasts claude stdout messages to all connected clients
 * - Forwards client messages (via onMessage callbacks) to claude stdin
 * - Passes ALL message types through transparently (including control_request
 *   for can_use_tool) — the web client handles permission approval
 * - Unrecognized message types are never blocked (future compatibility)
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WsServer {
  /** Send a string to all connected clients. */
  broadcast(data: string): void
  /** Register a callback for messages received from any client. */
  onMessage(cb: (data: string) => void): void
  /** Number of currently connected clients. */
  clientCount(): number
  /** Shut down the WebSocket server and disconnect all clients. */
  close(): void
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a WebSocket server attached to an existing HTTP server.
 *
 * The server is a transparent message bus:
 * - Client -> Server: triggers onMessage callbacks (raw string)
 * - Server -> Client: broadcast() sends to all connected clients
 *
 * No message filtering or transformation is performed — all JSON types
 * (assistant, result, control_request, control_response, etc.) pass
 * through as-is. This keeps the bridge thin and lets the web client
 * handle protocol logic like permission approval.
 *
 * @param httpServer - An existing http.Server to attach to
 * @returns A WsServer handle
 */
export function createWsServer(httpServer: HttpServer): WsServer {
  const wss = new WebSocketServer({ server: httpServer })

  const clients = new Set<WebSocket>()
  const messageCallbacks: Array<(data: string) => void> = []

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws)

    ws.on('message', (raw: Buffer | string) => {
      const data = typeof raw === 'string' ? raw : raw.toString('utf8')
      // Fan out to all registered callbacks
      for (const cb of messageCallbacks) {
        cb(data)
      }
    })

    ws.on('close', () => {
      clients.delete(ws)
    })

    ws.on('error', () => {
      // Swallow per-client errors — the 'close' event will fire next
      // and handle cleanup. Logging can be added later if needed.
      clients.delete(ws)
    })
  })

  return {
    broadcast(data: string): void {
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data)
        }
      }
    },

    onMessage(cb: (data: string) => void): void {
      messageCallbacks.push(cb)
    },

    clientCount(): number {
      return clients.size
    },

    close(): void {
      // Close all client connections
      for (const ws of clients) {
        ws.close()
      }
      clients.clear()
      // Shut down the server
      wss.close()
    },
  }
}
