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
import { generateToken, createVerifyClient } from './auth.js'
import { createMessageCache } from './messageCache.js'
import { detectTailscale } from './tailscale.js'
import { checkClaudeVersion } from './versionCheck.js'

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
  // 0. T-38: Claude CLI version compatibility check (non-blocking)
  // -----------------------------------------------------------------------
  const versionResult = await checkClaudeVersion()
  if (versionResult.warning) {
    console.warn(`\n   ⚠  ${versionResult.warning}\n`)
  } else if (versionResult.version) {
    console.log(`   Claude CLI version: ${versionResult.version}`)
  }

  // -----------------------------------------------------------------------
  // 1. Generate authentication token
  // -----------------------------------------------------------------------
  const token = generateToken()

  // -----------------------------------------------------------------------
  // 2. Start HTTP server (serves web UI static files + health/sessions API)
  // -----------------------------------------------------------------------
  const { server, url } = await startHttpServer(port)

  // -----------------------------------------------------------------------
  // 3. Create WebSocket server with token auth
  // -----------------------------------------------------------------------
  const ws = createWsServer(server, {
    verifyClient: createVerifyClient(token),
  })

  // -----------------------------------------------------------------------
  // 4. Create message cache for reconnect replay
  // -----------------------------------------------------------------------
  const cache = createMessageCache(200)
  let seq = 0

  // On new connection, check ?last_seq query param and replay cached messages
  // Replayed messages use the same seq envelope format as live broadcasts.
  ws.onConnection((socket, req) => {
    const urlObj = new URL(req.url ?? '/', 'http://localhost')
    const lastSeqParam = urlObj.searchParams.get('last_seq')
    if (lastSeqParam !== null) {
      const lastSeq = parseInt(lastSeqParam, 10)
      if (!Number.isNaN(lastSeq)) {
        const missed = cache.replayWithSeq(lastSeq)
        for (const entry of missed) {
          const envelope = JSON.stringify({ seq: entry.seq, data: entry.message })
          socket.send(envelope)
        }
        if (missed.length > 0) {
          console.log(`   Replay: ${missed.length} cached messages from seq ${lastSeq + 1}`)
        }
      }
    }
  })

  // -----------------------------------------------------------------------
  // 5. Detect Tailscale + print terminal UI banner (with token in URLs)
  // -----------------------------------------------------------------------
  const tailscale = await detectTailscale()
  await printStartupBanner(url, port, token, tailscale)

  // -----------------------------------------------------------------------
  // 6. Spawn claude process
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
  // 7. Create line reader for claude stdout
  // -----------------------------------------------------------------------
  const reader = createLineReader(claude.stdout)
  const iterator = reader[Symbol.asyncIterator]()

  // -----------------------------------------------------------------------
  // 8. Initialize handshake — must complete before we start bridging
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
  // 9. Bidirectional bridge
  //    WS client message  →  write to claude stdin
  //    claude stdout line  →  cache + broadcast to all WS clients
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

  // claude → cache + broadcast to all clients (continuous read loop)
  // Each message is wrapped in a seq envelope: {"seq": N, "data": "<original JSON>"}
  // so the web client can track its position and request replay on reconnect.
  ;(async () => {
    try {
      for (;;) {
        const { value, done } = await iterator.next()
        if (done) break
        // Assign sequence number, cache raw message, broadcast with seq envelope
        seq++
        cache.push(value, seq)
        const envelope = JSON.stringify({ seq, data: value })
        ws.broadcast(envelope)
      }
    } catch (err) {
      console.error('Error reading claude stdout:', err)
    }
  })()

  // -----------------------------------------------------------------------
  // 10. Claude process exit handler
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
