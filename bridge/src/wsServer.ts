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
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { VerifyClientInfo, VerifyClientCallback } from './auth.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max bufferedAmount (bytes) before a client is skipped during broadcast. */
const BACKPRESSURE_THRESHOLD = 1_048_576 // 1 MB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Optional configuration for createWsServer. */
export interface WsServerOptions {
  /** ws verifyClient function for authentication. */
  verifyClient?: (info: VerifyClientInfo, cb: VerifyClientCallback) => void
}

export interface WsServer {
  /** Send a string to all connected clients. */
  broadcast(data: string): void
  /** Register a callback for messages received from any client. */
  onMessage(cb: (data: string) => void): void
  /** Unregister a previously registered message callback. */
  offMessage(cb: (data: string) => void): void
  /** Register a callback for new connections. Receives the WebSocket and upgrade request. */
  onConnection(cb: (socket: WebSocket, req: IncomingMessage) => void): void
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
 * @param options - Optional configuration (e.g. verifyClient for auth)
 * @returns A WsServer handle
 */
export function createWsServer(httpServer: HttpServer, options?: WsServerOptions): WsServer {
  const wssOptions: ConstructorParameters<typeof WebSocketServer>[0] = { server: httpServer }
  if (options?.verifyClient) {
    wssOptions.verifyClient = options.verifyClient as any
  }
  const wss = new WebSocketServer(wssOptions)

  const clients = new Set<WebSocket>()
  const messageCallbacks: Array<(data: string) => void> = []
  const connectionCallbacks: Array<(socket: WebSocket, req: IncomingMessage) => void> = []

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Notify connection listeners (before adding to clients set,
    // so replay can send directly to the socket)
    for (const cb of connectionCallbacks) {
      cb(ws, req)
    }
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
        if (ws.readyState !== WebSocket.OPEN) continue
        if (ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
          console.warn(
            `[wsServer] skipping client (bufferedAmount ${ws.bufferedAmount} > ${BACKPRESSURE_THRESHOLD})`,
          )
          continue
        }
        ws.send(data)
      }
    },

    onMessage(cb: (data: string) => void): void {
      messageCallbacks.push(cb)
    },

    offMessage(cb: (data: string) => void): void {
      const idx = messageCallbacks.indexOf(cb)
      if (idx !== -1) messageCallbacks.splice(idx, 1)
    },

    onConnection(cb: (socket: WebSocket, req: IncomingMessage) => void): void {
      connectionCallbacks.push(cb)
    },

    clientCount(): number {
      return clients.size
    },

    close(): void {
      // Stop accepting new connections first
      wss.close()
      // Clear all callbacks — no more forwarding after close
      messageCallbacks.length = 0
      connectionCallbacks.length = 0
      // Initiate graceful close on each client.
      // Actual removal from `clients` happens in the per-socket 'close' handler.
      for (const ws of clients) {
        ws.close()
      }
    },
  }
}
