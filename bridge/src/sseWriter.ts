/**
 * sseWriter.ts — SSE connection manager for broadcasting to web clients.
 *
 * Replaces wsServer.ts for the server-to-client direction. Each connected
 * web client is a kept-alive HTTP response. This module:
 * - Manages the set of active SSE client connections
 * - Authenticates clients via ?token=xxx query param
 * - Replays missed messages on reconnect via Last-Event-ID / ?from_seq=N
 * - Broadcasts sequenced claude output messages and session status events
 * - Sends keepalive events every 15 s to prevent proxy timeouts
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MessageCache } from './messageCache.js'
import { verifyToken } from './auth.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max writableLength (bytes) before a client is skipped during broadcast. */
const BACKPRESSURE_THRESHOLD = 1_048_576 // 1 MB

/** Interval in milliseconds between keepalive comments. */
const KEEPALIVE_INTERVAL_MS = 15_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SseWriter {
  /** Send a sequenced message to all connected clients. */
  broadcast(seq: number, data: string): void
  /** Send a session_status event (no seq number). */
  broadcastStatus(state: string, extra?: Record<string, unknown>): void
  /** Number of currently connected SSE clients. */
  clientCount(): number
  /** Close all SSE connections and stop keepalive timer. */
  close(): void
}

export interface SseWriterDeps {
  /** Auth token — SSE clients must pass ?token=xxx */
  authToken?: string
  /** Message cache for replaying missed messages to reconnecting clients. */
  messageCache: MessageCache
  /** Returns current session state, sent immediately to new connections. */
  getSessionState: () => { state: string; [key: string]: unknown }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create an SSE connection manager.
 *
 * Returns both the SseWriter handle and an HTTP request handler that should
 * be wired to GET /events/stream on the HTTP server.
 *
 * The SSE frame format is:
 *   - Sequenced message:  id:<seq>\nevent:message\ndata:<json>\n\n
 *   - Status event:       event:session_status\ndata:<json>\n\n
 *   - Keepalive event:   event:keepalive\ndata:\n\n
 *
 * @param deps - Dependencies: authToken, messageCache, getSessionState
 * @returns { writer, handleSseRequest }
 */
export function createSseWriter(deps: SseWriterDeps): {
  writer: SseWriter
  /** HTTP request handler for GET /events/stream */
  handleSseRequest: (req: IncomingMessage, res: ServerResponse) => void
} {
  const { authToken, messageCache, getSessionState } = deps

  const clients = new Set<ServerResponse>()

  // -------------------------------------------------------------------------
  // Keepalive timer
  // -------------------------------------------------------------------------

  const keepaliveTimer = setInterval(() => {
    writeToAll('event:keepalive\ndata:\n\n')
  }, KEEPALIVE_INTERVAL_MS)

  // Prevent the timer from keeping the Node.js process alive on its own
  if (keepaliveTimer.unref) keepaliveTimer.unref()

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Write a raw SSE frame string to all connected clients.
   * Skips destroyed or backpressure-stalled responses.
   */
  function writeToAll(frame: string): void {
    for (const res of clients) {
      if (res.destroyed) { clients.delete(res); continue }
      if (res.writableLength >= BACKPRESSURE_THRESHOLD) {
        console.warn(
          `[sseWriter] skipping client (writableLength ${res.writableLength} > ${BACKPRESSURE_THRESHOLD})`,
        )
        continue
      }
      res.write(frame)
    }
  }

  /**
   * Write a raw SSE frame string to a single response.
   * Returns false if the write was skipped (destroyed or backpressure).
   */
  function writeToOne(res: ServerResponse, frame: string): boolean {
    if (res.destroyed) return false
    if (res.writableLength >= BACKPRESSURE_THRESHOLD) {
      console.warn(
        `[sseWriter] skipping initial write (writableLength ${res.writableLength} > ${BACKPRESSURE_THRESHOLD})`,
      )
      return false
    }
    res.write(frame)
    return true
  }

  // -------------------------------------------------------------------------
  // HTTP request handler
  // -------------------------------------------------------------------------

  function handleSseRequest(req: IncomingMessage, res: ServerResponse): void {
    // Auth check — uses shared verifyToken (header + query param)
    if (!verifyToken(req, authToken)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    // --- SSE response headers ---
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    clients.add(res)

    // --- Send initial session state ---
    const sessionState = getSessionState()
    writeToOne(res, `event:session_status\ndata:${JSON.stringify(sessionState)}\n\n`)

    // --- Replay missed messages ---
    // Parse URL once for from_seq and last-event-id
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    const lastEventIdHeader = req.headers['last-event-id']
    const lastEventId =
      typeof lastEventIdHeader === 'string'
        ? parseInt(lastEventIdHeader, 10)
        : Array.isArray(lastEventIdHeader)
          ? parseInt(lastEventIdHeader[0] ?? '0', 10)
          : NaN

    const fromSeqParam = url.searchParams.get('from_seq')
    const fromSeqQuery = fromSeqParam !== null ? parseInt(fromSeqParam, 10) : NaN

    const fromSeq = Math.max(
      isNaN(lastEventId) ? 0 : lastEventId,
      isNaN(fromSeqQuery) ? 0 : fromSeqQuery,
    )

    if (fromSeq > 0) {
      const missed = messageCache.replayWithSeq(fromSeq)
      for (const entry of missed) {
        if (!writeToOne(res, `id:${entry.seq}\nevent:message\ndata:${entry.message}\n\n`)) {
          break // response was destroyed mid-replay
        }
      }
    }

    // --- Cleanup on disconnect ---
    res.on('close', () => {
      clients.delete(res)
    })
  }

  // -------------------------------------------------------------------------
  // SseWriter interface
  // -------------------------------------------------------------------------

  const writer: SseWriter = {
    broadcast(seq: number, data: string): void {
      writeToAll(`id:${seq}\nevent:message\ndata:${data}\n\n`)
    },

    broadcastStatus(state: string, extra?: Record<string, unknown>): void {
      const payload = extra ? { state, ...extra } : { state }
      writeToAll(`event:session_status\ndata:${JSON.stringify(payload)}\n\n`)
    },

    clientCount(): number {
      return clients.size
    },

    close(): void {
      clearInterval(keepaliveTimer)
      for (const res of clients) {
        res.end()
      }
      clients.clear()
    },
  }

  return { writer, handleSseRequest }
}
