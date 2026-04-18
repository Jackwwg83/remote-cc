/**
 * httpServer.ts — HTTP server for the bridge.
 *
 * This is the entry point for the bridge:
 * - Serves the web UI from ../web/dist/ (Vite build output) as static files
 * - Falls back to a placeholder if the dist directory doesn't exist
 * - Exposes health check at GET /health
 * - Exposes session list at GET /sessions
 * - Returns 404 for unknown routes
 * - Adds CORS headers to all responses (dev convenience)
 * - Exposes GET /events/stream for SSE transport (via sseHandler dep)
 * - Exposes POST /messages for client-to-server messages
 */

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostname, platform, arch, cpus, totalmem } from 'node:os'
import type { ProcessManager, ProcessState } from './processManager.js'
import type { SessionInfo } from './sessionScanner.js'
import type { ClaudeProcess, SpawnClaudeOptions } from './spawner.js'
import { verifyToken } from './auth.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION = '0.1.0'
const BRIDGE_VERSION = '0.2.0'

// Resolve the web dist directory relative to this file's location.
// In dev (tsx): src/httpServer.ts → ../../web/dist
// In prod (compiled): dist/httpServer.js → ../../web/dist
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const WEB_DIST_DIR = join(__dirname, '..', '..', 'web', 'dist')
const WEB_DIST_EXISTS = existsSync(WEB_DIST_DIR)

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

/**
 * Optional dependencies injected into the HTTP server.
 * Keeps httpServer decoupled from concrete implementations for testability.
 */
export interface HttpServerDeps {
  /** Scan for existing Claude sessions. Returns SessionInfo[] sorted desc. */
  scanSessions?: () => Promise<SessionInfo[]>
  /** Process lifecycle manager — start/stop/status */
  processManager?: ProcessManager
  /** Called after a process is started via POST /sessions/start.
   *  index.ts hooks this to wire up lineReader, SSE bridge, etc.
   *  sessionId is provided when resuming an existing session. */
  onSessionStarted?: (proc: ClaudeProcess, sessionId?: string) => void
  /** Auth token for session control endpoints. If set, these endpoints require
   *  `Authorization: Bearer <token>` header or `?token=` query parameter. */
  authToken?: string
  /** SSE writer request handler — handles GET /events/stream */
  sseHandler?: (req: IncomingMessage, res: ServerResponse) => void
  /** Callback for POST /messages — returns false if no active session (→ 503) */
  onMessageReceived?: (msg: Record<string, unknown>) => boolean
  /** Recent message IDs for POST idempotency dedup */
  recentMessageIds?: Set<string>
  /** This machine's ID (UUID) — exposed at GET /machine/info */
  machineId?: string
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':  'font/ttf',
}

const PLACEHOLDER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>remote-cc</title>
</head>
<body>
  <h1>remote-cc</h1>
  <p>Web UI not built yet. Run <code>cd web && npm run build</code> first,</p>
  <p>or use the Vite dev server: <code>cd web && npm run dev</code></p>
</body>
</html>`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Send a JSON response with CORS headers. */
function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body)
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value)
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(json)
}

/** Send an HTML response with CORS headers. */
function sendHtml(res: ServerResponse, statusCode: number, html: string): void {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value)
  }
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

/**
 * Try to serve a static file from the web dist directory (async).
 * Returns true if the file was served, false otherwise.
 */
async function tryServeStatic(urlPath: string, res: ServerResponse): Promise<boolean> {
  if (!WEB_DIST_EXISTS) return false

  const filePath = urlPath === '/' ? '/index.html' : urlPath
  const fullPath = resolve(WEB_DIST_DIR, '.' + filePath)

  // Security: ensure resolved path is within the dist directory (+ separator to block /dist-evil/)
  if (!fullPath.startsWith(WEB_DIST_DIR + '/')) return false
  const ext = extname(fullPath)
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'

  try {
    const content = await readFile(fullPath)
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      res.setHeader(key, value)
    }
    res.writeHead(200, { 'Content-Type': contentType })
    res.end(content)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Body parsing helper
// ---------------------------------------------------------------------------

// Auth check delegates to shared verifyToken from auth.ts

/** Max body size for POST requests (64 KiB — more than enough for JSON control messages). */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Read the request body as a parsed JSON object.
 * Returns the parsed value, or throws a descriptive error string.
 */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy()
        reject('Request body too large')
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) {
        // Empty body is treated as empty object
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          reject('Body must be a JSON object')
          return
        }
        resolve(parsed as Record<string, unknown>)
      } catch {
        reject('Invalid JSON')
      }
    })

    req.on('error', () => {
      reject('Request read error')
    })
  })
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

function createRequestHandler(deps: HttpServerDeps) {
  return function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Delegate to async handler, catch unhandled promise rejections
    handleRequestAsync(req, res, deps).catch((err) => {
      console.error('[httpServer] Unhandled error in request handler:', err)
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal Server Error' })
      }
    })
  }
}

async function handleRequestAsync(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
): Promise<void> {
  const { method } = req
  const rawUrl = req.url ?? '/'

  // Parse URL once — use pathname for all route matching (supports query params)
  const urlObj = new URL(rawUrl, `http://${req.headers.host ?? 'localhost'}`)
  const pathname = urlObj.pathname

  // CORS preflight
  if (method === 'OPTIONS') {
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      res.setHeader(key, value)
    }
    res.writeHead(204)
    res.end()
    return
  }

  // API routes first (before static file serving)

  // Route: GET /health
  if (method === 'GET' && pathname === '/health') {
    sendJson(res, 200, { ok: true, version: VERSION })
    return
  }

  // Route: GET /machine/info — machine identity + system info
  if (method === 'GET' && pathname === '/machine/info') {
    if (!verifyToken(req, deps.authToken)) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }
    sendJson(res, 200, {
      machineId: deps.machineId ?? '',
      hostname: hostname(),
      os: platform(),
      arch: arch(),
      cpuCount: cpus().length,
      memGB: Math.round(totalmem() / 1024 ** 3),
      nodeVersion: process.version,
      bridgeVersion: BRIDGE_VERSION,
    })
    return
  }

  // Route: GET /events/stream — SSE transport
  if (method === 'GET' && pathname === '/events/stream') {
    if (!deps.sseHandler) {
      sendJson(res, 503, { error: 'SSE not available' })
      return
    }
    // Auth is handled inside sseHandler (it checks ?token)
    deps.sseHandler(req, res)
    return
  }

  // Route: GET /sessions/history (or /sessions alias) — list all scannable sessions
  if (method === 'GET' && (pathname === '/sessions/history' || pathname === '/sessions')) {
    if (!verifyToken(req, deps.authToken)) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }
    if (!deps.scanSessions) {
      sendJson(res, 200, { sessions: [] })
      return
    }
    const sessions = await deps.scanSessions()
    sendJson(res, 200, { sessions })
    return
  }

  // Route: GET /sessions/status — current process state
  if (method === 'GET' && pathname === '/sessions/status') {
    if (!verifyToken(req, deps.authToken)) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }
    const pm = deps.processManager
    if (!pm) {
      sendJson(res, 200, { state: 'idle' as ProcessState })
      return
    }
    sendJson(res, 200, {
      state: pm.state,
      ...(pm.sessionId ? { sessionId: pm.sessionId } : {}),
    })
    return
  }

  // Route: POST /messages — receive client messages for SSE transport
  if (method === 'POST' && pathname === '/messages') {
    if (!verifyToken(req, deps.authToken)) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }

    // Parse body
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (err) {
      sendJson(res, 400, { error: typeof err === 'string' ? err : 'Bad request' })
      return
    }

    // Idempotency check: if _messageId is present and already seen, return 200 silently
    const messageId = body._messageId as string | undefined
    if (messageId && deps.recentMessageIds?.has(messageId)) {
      sendJson(res, 200, { ok: true, deduplicated: true })
      return
    }

    // Forward to claude
    if (!deps.onMessageReceived) {
      sendJson(res, 503, { error: 'No message handler registered' })
      return
    }

    const ok = deps.onMessageReceived(body)
    if (!ok) {
      sendJson(res, 503, { error: 'No active session' })
      return
    }

    // Track message ID for dedup
    if (messageId && deps.recentMessageIds) {
      deps.recentMessageIds.add(messageId)
      // Prune old IDs (keep last 100)
      if (deps.recentMessageIds.size > 100) {
        const first = deps.recentMessageIds.values().next().value
        if (first) deps.recentMessageIds.delete(first)
      }
    }

    sendJson(res, 200, { ok: true })
    return
  }

  // Route: POST /sessions/start — start a new or resumed session
  if (method === 'POST' && pathname === '/sessions/start') {
    if (!verifyToken(req, deps.authToken)) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }
    const pm = deps.processManager
    if (!pm) {
      sendJson(res, 500, { error: 'Process manager not available' })
      return
    }

    // Reject if already running/spawning
    if (pm.state !== 'idle') {
      sendJson(res, 409, {
        error: `Cannot start: process is in '${pm.state}' state`,
        state: pm.state,
      })
      return
    }

    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (err) {
      sendJson(res, 400, { error: typeof err === 'string' ? err : 'Bad request' })
      return
    }

    // Validate body fields
    const sessionId = body.sessionId
    const cwd = body.cwd

    if (sessionId !== undefined && typeof sessionId !== 'string') {
      sendJson(res, 400, { error: 'sessionId must be a string' })
      return
    }
    if (cwd !== undefined && typeof cwd !== 'string') {
      sendJson(res, 400, { error: 'cwd must be a string' })
      return
    }

    // Build spawn options
    const spawnOpts: SpawnClaudeOptions = {}
    if (sessionId) {
      spawnOpts.mode = 'resume'
      spawnOpts.sessionId = sessionId
    } else {
      spawnOpts.mode = 'new'
    }

    const targetCwd = (cwd as string | undefined) ?? process.cwd()

    try {
      const proc = await pm.start(targetCwd, spawnOpts)
      // Notify index.ts (or whoever registered the callback) so it can
      // wire up lineReader, WS bridge, etc.
      deps.onSessionStarted?.(proc, sessionId as string | undefined)
      sendJson(res, 200, {
        ok: true,
        sessionId: pm.sessionId ?? null,
      })
    } catch (err) {
      // start() throws if state is not idle (concurrent spawn race)
      const message = err instanceof Error ? err.message : 'Spawn failed'
      sendJson(res, 409, { error: message })
    }
    return
  }

  // Route: POST /sessions/stop — stop the current process
  if (method === 'POST' && pathname === '/sessions/stop') {
    if (!verifyToken(req, deps.authToken)) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }
    const pm = deps.processManager
    if (!pm) {
      sendJson(res, 200, { ok: true })
      return
    }
    await pm.stop()
    sendJson(res, 200, { ok: true })
    return
  }

  // Static file serving for GET requests
  if (method === 'GET') {
    if (await tryServeStatic(pathname, res)) return

    if (pathname !== '/' && !extname(pathname) && WEB_DIST_EXISTS) {
      if (await tryServeStatic('/', res)) return
    }

    // No dist dir — show placeholder
    if (pathname === '/') {
      sendHtml(res, 200, PLACEHOLDER_HTML)
      return
    }
  }

  // 404 for everything else
  sendJson(res, 404, { error: 'Not Found' })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the HTTP server on the given port.
 *
 * The returned http.Server handles all transport (SSE via sseHandler dep,
 * client messages via onMessageReceived dep).
 *
 * @param port - Port number to listen on (0 for random)
 * @param deps - Optional dependencies (processManager, scanSessions, etc.)
 * @returns The http.Server instance and the resolved URL
 */
export function startHttpServer(
  port: number,
  deps?: HttpServerDeps,
): Promise<{ server: HttpServer; url: string }> {
  return new Promise((resolve, reject) => {
    const handler = createRequestHandler(deps ?? {})
    const server = createServer(handler)

    server.on('error', reject)

    const host = process.env.REMOTE_CC_HOST ?? '0.0.0.0'
    server.listen(port, host, () => {
      const addr = server.address()
      let resolvedHost = '0.0.0.0'
      let resolvedPort = port
      if (typeof addr === 'object' && addr !== null) {
        resolvedHost = addr.address
        resolvedPort = addr.port
      }
      resolve({
        server,
        url: `http://${resolvedHost}:${resolvedPort}`,
      })
    })
  })
}
