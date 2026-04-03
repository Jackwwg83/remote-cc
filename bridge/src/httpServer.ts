/**
 * httpServer.ts — HTTP server for the bridge.
 *
 * This is the entry point for the bridge:
 * - Serves a placeholder HTML page at GET / (replaced later by web UI)
 * - Exposes health check at GET /health
 * - Exposes session list at GET /sessions
 * - Returns 404 for unknown routes
 * - Adds CORS headers to all responses (dev convenience)
 * - The underlying http.Server supports WebSocket upgrade — the wsServer
 *   from T-05 attaches to this server for WS connections
 */

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION = '0.1.0'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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
  <p>Web UI coming soon.</p>
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

  // Route: GET /
  if (method === 'GET' && url === '/') {
    sendHtml(res, 200, PLACEHOLDER_HTML)
    return
  }

  // Route: GET /health
  if (method === 'GET' && url === '/health') {
    sendJson(res, 200, { ok: true, version: VERSION })
    return
  }

  // Route: GET /sessions
  // TODO: integrate with wsServer state to return real session list (T-12 wiring)
  if (method === 'GET' && url === '/sessions') {
    sendJson(res, 200, [])
    return
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
