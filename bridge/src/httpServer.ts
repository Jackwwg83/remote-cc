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
 * - The underlying http.Server supports WebSocket upgrade — the wsServer
 *   from T-05 attaches to this server for WS connections
 */

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION = '0.1.0'

// Resolve the web dist directory relative to this file's location.
// In dev (tsx): src/httpServer.ts → ../../web/dist
// In prod (compiled): dist/httpServer.js → ../../web/dist
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const WEB_DIST_DIR = join(__dirname, '..', '..', 'web', 'dist')
const WEB_DIST_EXISTS = existsSync(WEB_DIST_DIR)

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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
 * Try to serve a static file from the web dist directory.
 * Returns true if the file was served, false otherwise.
 */
function tryServeStatic(urlPath: string, res: ServerResponse): boolean {
  if (!WEB_DIST_EXISTS) return false

  // Normalize: "/" → "/index.html"
  let filePath = urlPath === '/' ? '/index.html' : urlPath

  // Security: prevent directory traversal
  if (filePath.includes('..')) return false

  const fullPath = join(WEB_DIST_DIR, filePath)

  // Check file exists
  if (!existsSync(fullPath)) return false

  const ext = extname(fullPath)
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'

  try {
    const content = readFileSync(fullPath)
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
// Request handler
// ---------------------------------------------------------------------------

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const { method, url } = req

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
  if (method === 'GET' && url === '/health') {
    sendJson(res, 200, { ok: true, version: VERSION })
    return
  }

  // Route: GET /sessions
  if (method === 'GET' && url === '/sessions') {
    sendJson(res, 200, [])
    return
  }

  // Static file serving for GET requests
  if (method === 'GET' && url) {
    // Strip query string for file path resolution
    const urlPath = url.split('?')[0]

    // Try to serve from web/dist/
    if (tryServeStatic(urlPath, res)) return

    // SPA fallback: for paths that don't match a file, serve index.html
    // (lets client-side routing work if we add it later)
    if (urlPath !== '/' && !extname(urlPath) && WEB_DIST_EXISTS) {
      if (tryServeStatic('/', res)) return
    }

    // No dist dir — show placeholder
    if (url === '/' || url.startsWith('/?')) {
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
 * The returned http.Server can be passed to createWsServer() for
 * WebSocket upgrade support.
 *
 * @param port - Port number to listen on (0 for random)
 * @returns The http.Server instance and the resolved URL
 */
export function startHttpServer(port: number): Promise<{ server: HttpServer; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handleRequest)

    server.on('error', reject)

    server.listen(port, '0.0.0.0', () => {
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
