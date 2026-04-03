#!/usr/bin/env node
/**
 * remote-cc bridge — spawn claude + WebSocket server + terminal UI
 *
 * Wires together all modules:
 *   HTTP server  →  serves web UI static files
 *   WS server    →  attaches to HTTP server for WebSocket upgrade
 *   spawner      →  launches claude child process
 *   lineReader   →  buffered line reader for claude stdout
 *   initializer  →  handles the initialize handshake
 *   terminalUI   →  prints startup banner and connection status
 *
 * Data flow:
 *   Web client  →  WS  →  claude stdin
 *   claude stdout  →  WS broadcast  →  all Web clients
 */

import { parseArgs } from 'node:util'
import { startHttpServer } from './httpServer.js'
import { createWsServer } from './wsServer.js'
import { spawnClaude, SpawnError } from './spawner.js'
import { createLineReader, writeLine } from './lineReader.js'
import { waitForInitialize, InitializeTimeoutError } from './initializer.js'
import { printStartupBanner } from './terminalUI.js'

const { values: args } = parseArgs({
  options: {
    relay: { type: 'string', short: 'r' },
    port: { type: 'string', short: 'p', default: '7860' },
    local: { type: 'boolean', default: true },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
})

if (args.version) {
  console.log('remote-cc v0.1.0')
  process.exit(0)
}

if (args.help) {
  console.log(`
remote-cc — Remote control for Claude Code

Usage:
  remote-cc [options]

Options:
  --port, -p <port>    WebSocket server port (default: 7860)
  --relay, -r <url>    Connect to a relay server (V2, not yet implemented)
  --local              Direct connect mode via Tailscale (default)
  --help, -h           Show this help
  --version, -v        Show version
  `)
  process.exit(0)
}

async function main() {
  const port = parseInt(args.port ?? '7860', 10)

  // -----------------------------------------------------------------------
  // 1. Start HTTP server (serves web UI static files + health/sessions API)
  // -----------------------------------------------------------------------
  const { server, url } = await startHttpServer(port)

  // -----------------------------------------------------------------------
  // 2. Create WebSocket server (attaches to the HTTP server for WS upgrade)
  // -----------------------------------------------------------------------
  const ws = createWsServer(server)

  // -----------------------------------------------------------------------
  // 3. Print terminal UI banner
  // -----------------------------------------------------------------------
  printStartupBanner(url, port)

  // -----------------------------------------------------------------------
  // 4. Spawn claude process
  // -----------------------------------------------------------------------
  let claude
  try {
    claude = spawnClaude(process.cwd())
  } catch (err) {
    if (err instanceof SpawnError) {
      console.error(`\nFailed to start claude: ${err.message}`)
      console.error(
        'Make sure "claude" is installed and available in your PATH.\n' +
        'Install: npm install -g @anthropic-ai/claude-code\n',
      )
    } else {
      console.error('\nUnexpected error spawning claude:', err)
    }
    ws.close()
    server.close()
    process.exit(1)
  }

  // -----------------------------------------------------------------------
  // 5. Create line reader for claude stdout
  // -----------------------------------------------------------------------
  const reader = createLineReader(claude.stdout)
  const iterator = reader[Symbol.asyncIterator]()

  // -----------------------------------------------------------------------
  // 6. Initialize handshake — must complete before we start bridging
  // -----------------------------------------------------------------------
  try {
    await waitForInitialize(
      iterator,
      (obj) => writeLine(claude.stdin, obj),
    )
    // preInitMessages are intentionally not broadcast to clients —
    // they arrive before any client is connected.
  } catch (err) {
    if (err instanceof InitializeTimeoutError) {
      console.error('\nClaude did not send initialize request within timeout.')
      console.error('The claude process may have crashed or is not responding.\n')
    } else {
      console.error('\nInitialize handshake failed:', err)
    }
    claude.kill()
    ws.close()
    server.close()
    process.exit(1)
  }

  console.log('   Claude process ready (initialize handshake complete)')

  // -----------------------------------------------------------------------
  // 7. Bidirectional bridge
  //    WS client message  →  write to claude stdin
  //    claude stdout line  →  broadcast to all WS clients
  // -----------------------------------------------------------------------

  // Client → claude
  ws.onMessage((data: string) => {
    try {
      const parsed = JSON.parse(data)
      writeLine(claude.stdin, parsed)
    } catch {
      // Malformed JSON from client — silently ignore
    }
  })

  // claude → all clients (continuous read loop)
  ;(async () => {
    try {
      for (;;) {
        const { value, done } = await iterator.next()
        if (done) break
        // value is a raw JSON string line — broadcast as-is
        ws.broadcast(value)
      }
    } catch (err) {
      console.error('Error reading claude stdout:', err)
    }
  })()

  // -----------------------------------------------------------------------
  // 8. Claude process exit handler
  // -----------------------------------------------------------------------
  claude.on('exit', (code) => {
    console.log(`\n   Claude process exited with code ${code ?? 0}`)
    ws.close()
    server.close()
    process.exit(code ?? 0)
  })
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
