#!/usr/bin/env node
/**
 * remote-cc bridge — HTTP server + WebSocket server + session lifecycle
 *
 * Wires together all modules:
 *   HTTP server  →  serves web UI static files + session API
 *   WS server    →  attaches to HTTP server for WebSocket upgrade
 *   processManager → manages claude process lifecycle (start/stop/status)
 *   sessionScanner → scans ~/.claude/projects/ for existing sessions
 *   lineReader   →  buffered line reader for claude stdout
 *   initializer  →  handles the initialize handshake
 *   terminalUI   →  prints startup banner and connection status
 *
 * Startup flow:
 *   1. Start HTTP + WS servers
 *   2. Broadcast "waiting_for_session" to connected clients
 *   3. Wait for POST /sessions/start from web UI
 *   4. wireSession(): lineReader → initializer → bidirectional bridge
 *   5. On process exit: broadcast session_ended, reset, wait for next session
 */

import { parseArgs } from 'node:util'
import { startHttpServer } from './httpServer.js'
import { createWsServer } from './wsServer.js'
import { createLineReader, writeLine } from './lineReader.js'
import { waitForInitialize, InitializeTimeoutError } from './initializer.js'
import { printStartupBanner } from './terminalUI.js'
import { generateToken, createVerifyClient } from './auth.js'
import { createMessageCache } from './messageCache.js'
import { detectTailscale } from './tailscale.js'
import { checkClaudeVersion } from './versionCheck.js'
import { createProcessManager } from './processManager.js'
import { scanSessions } from './sessionScanner.js'
import type { ClaudeProcess } from './spawner.js'

const { values: args } = parseArgs({
  options: {
    relay: { type: 'string', short: 'r' },
    port: { type: 'string', short: 'p', default: '7860' },
    local: { type: 'boolean', default: true },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    continue: { type: 'boolean', short: 'c' },
    resume: { type: 'string' },
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
  --port, -p <port>       Server port (default: 7860)
  --continue, -c          Resume the most recent session
  --resume <session-id>   Resume a specific session by ID
  --relay, -r <url>       Connect to a relay server (V2, not yet implemented)
  --local                 Direct connect mode via Tailscale (default)
  --help, -h              Show this help
  --version, -v           Show version
  `)
  process.exit(0)
}

async function main() {
  const port = parseInt(args.port ?? '7860', 10)

  // -----------------------------------------------------------------------
  // 0. Claude CLI version compatibility check (non-blocking)
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
  // 2. Create process manager (manages claude process lifecycle)
  // -----------------------------------------------------------------------
  const pm = createProcessManager()

  // -----------------------------------------------------------------------
  // 3. Start HTTP server with deps (processManager, sessionScanner, callback)
  // -----------------------------------------------------------------------
  const { server, url } = await startHttpServer(port, {
    processManager: pm,
    scanSessions: () => scanSessions(),
    onSessionStarted: (proc) => wireSession(proc),
    authToken: token,
  })

  // -----------------------------------------------------------------------
  // 4. Create WebSocket server with token auth
  // -----------------------------------------------------------------------
  const ws = createWsServer(server, {
    verifyClient: createVerifyClient(token),
  })

  // -----------------------------------------------------------------------
  // 5. Create message cache for reconnect replay
  // -----------------------------------------------------------------------
  const cache = createMessageCache(200)
  let seq = 0

  // Track current session state for new WS connections
  let sessionState: 'waiting_for_session' | 'running' = 'waiting_for_session'

  // -----------------------------------------------------------------------
  // 6. On new WS connection: send current session state + replay cache
  // -----------------------------------------------------------------------
  ws.onConnection((socket, req) => {
    // Always send current session status to newly connected clients
    const statusMsg = JSON.stringify({
      type: 'system',
      subtype: 'session_status',
      state: sessionState,
    })
    socket.send(statusMsg)

    // Replay cached messages if client provides ?last_seq
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
  // 7. Detect Tailscale + print terminal UI banner (with token in URLs)
  // -----------------------------------------------------------------------
  const tailscale = await detectTailscale()
  await printStartupBanner(url, port, token, tailscale)

  // -----------------------------------------------------------------------
  // 8. wireSession() — called when POST /sessions/start spawns a process
  // -----------------------------------------------------------------------
  // Track the current onMessage unsubscribe handle so we can clean up
  // between sessions (onMessage callbacks accumulate otherwise).
  let currentMessageHandler: ((data: string) => void) | null = null

  function wireSession(proc: ClaudeProcess): void {
    console.log('   Wiring new session...')

    // Unregister previous session's message handler to prevent leaks
    if (currentMessageHandler) {
      ws.offMessage(currentMessageHandler)
      currentMessageHandler = null
    }

    // Create line reader for claude stdout
    const reader = createLineReader(proc.stdout)
    const iterator = reader[Symbol.asyncIterator]()

    // Run the initialize handshake, then start bridging
    // NOTE: session_status = running is broadcast AFTER init completes (not before)
    // to ensure clients don't send messages before the bridge is ready.
    ;(async () => {
      try {
        const initResult = await waitForInitialize(
          iterator,
          (obj) => writeLine(proc.stdin, obj),
        )
        console.log(`✅ Claude is ready (${initResult.mode})`)

        // Cache early messages so they can be replayed to late-connecting clients
        for (const msg of initResult.earlyMessages) {
          seq++
          cache.push(msg, seq)
        }
      } catch (err) {
        if (err instanceof InitializeTimeoutError) {
          console.error('\n❌ Claude did not produce any output within timeout.')
          console.error('Is claude installed? Try: claude --version\n')
        } else {
          console.error('\n❌ Claude startup failed:', err)
        }
        // Kill the process and let the exit handler reset state
        proc.kill()
        return
      }

      console.log('   Claude process ready (initialize handshake complete)')

      // Broadcast session_status = running AFTER init completes
      sessionState = 'running'
      ws.broadcast(JSON.stringify({
        type: 'system',
        subtype: 'session_status',
        state: 'running',
      }))

      // -------------------------------------------------------------------
      // Bidirectional bridge
      //   WS client message → write to claude stdin
      //   claude stdout line → cache + broadcast to all WS clients
      // -------------------------------------------------------------------

      // Client → claude (register a new message handler)
      currentMessageHandler = (data: string) => {
        try {
          const parsed = JSON.parse(data)
          writeLine(proc.stdin, parsed)
        } catch {
          // Malformed JSON from client — silently ignore
        }
      }
      ws.onMessage(currentMessageHandler)

      // claude → cache + broadcast (continuous read loop)
      try {
        for (;;) {
          const { value, done } = await iterator.next()
          if (done) break
          seq++
          cache.push(value, seq)
          const envelope = JSON.stringify({ seq, data: value })
          ws.broadcast(envelope)
        }
      } catch (err) {
        console.error('Error reading claude stdout:', err)
      }
    })()

    // -------------------------------------------------------------------
    // Process exit handler — reset to waiting state (don't exit the bridge)
    // -------------------------------------------------------------------
    proc.once('exit', (code) => {
      console.log(`\n   Claude process exited with code ${code ?? 0}`)

      // Unregister the message handler to prevent stale writes
      if (currentMessageHandler) {
        ws.offMessage(currentMessageHandler)
        currentMessageHandler = null
      }

      // Reset seq counter and message cache for the next session
      seq = 0
      cache.clear()

      // Update session state
      sessionState = 'waiting_for_session'

      // Broadcast session_ended + new waiting status to all clients
      ws.broadcast(JSON.stringify({
        type: 'system',
        subtype: 'session_status',
        state: 'session_ended',
        exitCode: code ?? 0,
      }))
      ws.broadcast(JSON.stringify({
        type: 'system',
        subtype: 'session_status',
        state: 'waiting_for_session',
      }))

      console.log('   Bridge waiting for next session...')
    })
  }

  // -----------------------------------------------------------------------
  // 9. Handle --continue / --resume auto-start, or broadcast waiting status
  // -----------------------------------------------------------------------
  if (args.continue) {
    // Auto-start: find most recent session and spawn with --continue
    const sessions = await scanSessions()
    if (sessions.length === 0) {
      console.log('   No existing sessions found. Starting new session...')
      await pm.start(process.cwd(), { mode: 'new' })
    } else {
      const latest = sessions[0] // sorted desc by time
      console.log(`   Continuing session: ${latest.shortId} (${latest.project})`)
      await pm.start(latest.cwd, { mode: 'continue' })
    }
    // wireSession is called via onSessionStarted callback
  } else if (args.resume) {
    // Auto-start: find session by ID and spawn with --resume
    const sessions = await scanSessions()
    const target = sessions.find(s => s.id === args.resume || s.shortId === args.resume)
    if (!target) {
      console.error(`   Session not found: ${args.resume}`)
      console.error('   Available sessions:')
      sessions.slice(0, 5).forEach(s => {
        console.error(`     ${s.shortId}  ${s.project}  ${s.summary.slice(0, 50)}`)
      })
      process.exit(1)
    }
    console.log(`   Resuming session: ${target.shortId} (${target.project})`)
    await pm.start(target.cwd, { mode: 'resume', sessionId: target.id })
    // wireSession is called via onSessionStarted callback
  } else {
    // Default: wait for web UI POST /sessions/start
    console.log('   Bridge started — waiting for session start via web UI')
    ws.broadcast(JSON.stringify({
      type: 'system',
      subtype: 'session_status',
      state: 'waiting_for_session',
    }))
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
