#!/usr/bin/env node
/**
 * remote-cc bridge — HTTP server + SSE transport + session lifecycle
 *
 * Wires together all modules:
 *   HTTP server    →  serves web UI static files + session API + SSE stream
 *   sseWriter      →  manages SSE connections for server-to-client broadcast
 *   processManager →  manages claude process lifecycle (start/stop/status)
 *   sessionScanner →  scans ~/.claude/projects/ for existing sessions
 *   lineReader     →  buffered line reader for claude stdout
 *   initializer    →  handles the initialize handshake
 *   terminalUI     →  prints startup banner and connection status
 *
 * Startup flow:
 *   1. Start HTTP server (serves SSE stream at GET /events/stream,
 *      accepts client messages at POST /messages)
 *   2. Broadcast "waiting_for_session" to connected SSE clients
 *   3. Wait for POST /sessions/start from web UI
 *   4. wireSession(): lineReader → initializer → bidirectional bridge
 *   5. On process exit: broadcast session_ended, reset, wait for next session
 */

import { parseArgs } from 'node:util'
import { hostname } from 'node:os'
import { startHttpServer } from './httpServer.js'
import { createSseWriter } from './sseWriter.js'
import { createLineReader, writeLine } from './lineReader.js'
import { waitForInitialize, InitializeTimeoutError } from './initializer.js'
import { printStartupBanner } from './terminalUI.js'
import { generateToken } from './auth.js'
import { createMessageCache } from './messageCache.js'
import { detectTailscale } from './tailscale.js'
import { checkClaudeVersion } from './versionCheck.js'
import { createProcessManager } from './processManager.js'
import { scanSessions } from './sessionScanner.js'
import type { ClaudeProcess } from './spawner.js'
import { readSessionHistory } from './sessionHistory.js'
import { getOrCreateMachineId } from './machineId.js'

const { values: args } = parseArgs({
  options: {
    relay: { type: 'string', short: 'r' },
    port: { type: 'string', short: 'p', default: '7860' },
    local: { type: 'boolean', default: true },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    continue: { type: 'boolean', short: 'c' },
    resume: { type: 'string' },
    role: { type: 'string' },              // 'server' | 'client' | 'standalone' (default)
    server: { type: 'string' },            // URL of server when role=client
    'server-token': { type: 'string' },   // cluster token when role=client
    'machine-name': { type: 'string' },   // display name, defaults to os.hostname()
    'cluster-token': { type: 'string' },  // cluster token when role=server (auto-gen if omitted)
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

Cluster Options:
  --role <role>           server | client | standalone (default: standalone)
  --server <url>          Server URL (required for --role client)
  --server-token <token>  Cluster token (required for --role client)
  --machine-name <name>   Display name (default: hostname)
  --cluster-token <token> Cluster token for server mode (auto-generated if omitted)
  `)
  process.exit(0)
}

// Module-scoped cluster config — available to later modules (T-M02, T-M03, T-M04, etc.)
export let clusterRole: 'server' | 'client' | 'standalone' = 'standalone'
export let clusterMachineId: string = ''
export let clusterMachineName: string = ''
export let clusterToken: string | undefined
export let clusterServerUrl: string | undefined
export let clusterServerToken: string | undefined

async function main() {
  const port = parseInt(args.port ?? '7860', 10)

  // -----------------------------------------------------------------------
  // 0-pre. Resolve role + cluster config
  // -----------------------------------------------------------------------
  const roleRaw = args.role ?? process.env.REMOTE_CC_ROLE ?? 'standalone'
  if (!['server', 'client', 'standalone'].includes(roleRaw)) {
    console.error(`Invalid role: ${roleRaw}. Must be server, client, or standalone.`)
    process.exit(1)
  }
  clusterRole = roleRaw as 'server' | 'client' | 'standalone'

  clusterMachineId = await getOrCreateMachineId()
  clusterMachineName = args['machine-name'] ?? process.env.REMOTE_CC_MACHINE_NAME ?? hostname()

  if (clusterRole === 'client') {
    const serverUrl = args.server ?? process.env.REMOTE_CC_SERVER
    const serverToken = args['server-token'] ?? process.env.REMOTE_CC_SERVER_TOKEN
    if (!serverUrl || !serverToken) {
      console.error('--role client requires --server <url> and --server-token <token>')
      console.error('(or REMOTE_CC_SERVER + REMOTE_CC_SERVER_TOKEN env vars)')
      process.exit(1)
    }
    clusterServerUrl = serverUrl
    clusterServerToken = serverToken
    console.log(`   Cluster role: client (connecting to ${serverUrl})`)
    console.log(`   Machine: ${clusterMachineName} (${clusterMachineId.slice(0, 8)}...)`)
  }

  if (clusterRole === 'server') {
    const providedToken = args['cluster-token'] ?? process.env.REMOTE_CC_CLUSTER_TOKEN
    if (!providedToken) {
      const { randomBytes } = await import('node:crypto')
      clusterToken = 'rcc_cluster_' + randomBytes(32).toString('base64url')
    } else {
      clusterToken = providedToken
    }
    console.log(`   Cluster role: server`)
    console.log(`   Machine: ${clusterMachineName} (${clusterMachineId.slice(0, 8)}...)`)
    console.log(`   Cluster token: ${clusterToken}`)
  }

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
  // 3. Create message cache + SSE writer (before HTTP server so we can
  //    pass sseHandler and onMessageReceived as deps)
  // -----------------------------------------------------------------------
  const cache = createMessageCache(200)
  let seq = 0
  let sessionState: 'waiting_for_session' | 'running' = 'waiting_for_session'

  // Message dedup set for POST /messages idempotency
  const recentMessageIds = new Set<string>()

  const { writer: sse, handleSseRequest } = createSseWriter({
    authToken: token,
    messageCache: cache,
    getSessionState: () => ({ state: sessionState }),
  })

  // Track current message handler for cleanup between sessions
  let currentMessageHandler: ((msg: Record<string, unknown>) => boolean) | null = null

  // -----------------------------------------------------------------------
  // 4. Start HTTP server with SSE + message deps
  // -----------------------------------------------------------------------
  const { server, url } = await startHttpServer(port, {
    processManager: pm,
    scanSessions: () => scanSessions(),
    onSessionStarted: (proc, sessionId) => wireSession(proc, sessionId),
    authToken: token,
    sseHandler: handleSseRequest,
    onMessageReceived: (msg) => {
      if (!currentMessageHandler) return false
      return currentMessageHandler(msg)
    },
    recentMessageIds,
  })

  // -----------------------------------------------------------------------
  // 5. Detect Tailscale + print terminal UI banner (with token in URLs)
  // -----------------------------------------------------------------------
  const tailscale = await detectTailscale()
  await printStartupBanner(url, port, token, tailscale)

  // -----------------------------------------------------------------------
  // 6. wireSession() — called when POST /sessions/start spawns a process
  // -----------------------------------------------------------------------

  function wireSession(proc: ClaudeProcess, sessionId?: string): void {
    console.log('   Wiring new session...')

    // Clear previous message handler
    currentMessageHandler = null

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

      // Register message handler FIRST so user input works immediately
      currentMessageHandler = (msg: Record<string, unknown>) => {
        try {
          writeLine(proc.stdin, msg)
          return true
        } catch {
          return false
        }
      }

      // Switch to running state FIRST so UI shows chat view
      sessionState = 'running'
      sse.broadcastStatus('running')

      // THEN replay conversation history (arrives after UI is in chat view)
      if (sessionId) {
        try {
          const history = await readSessionHistory(sessionId)
          if (history.length > 0) {
            console.log(`   Replaying ${history.length} historical messages`)
            for (const msg of history) {
              seq++
              cache.push(msg.raw, seq)
              sse.broadcast(seq, msg.raw)
            }
          }
        } catch (err) {
          console.error('   Warning: failed to read session history:', err)
        }
      }

      // claude → cache + SSE broadcast (continuous read loop)
      // sseWriter formats as SSE frame (id/event/data) — no envelope needed here
      try {
        for (;;) {
          const { value, done } = await iterator.next()
          if (done) break
          seq++
          cache.push(value, seq)
          sse.broadcast(seq, value)
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

      // Clear the message handler to prevent stale writes
      currentMessageHandler = null

      // Reset seq counter, message cache, and dedup set for the next session
      seq = 0
      cache.clear()
      recentMessageIds.clear()

      // Update session state
      sessionState = 'waiting_for_session'

      // Broadcast session_ended + new waiting status to all SSE clients
      sse.broadcastStatus('session_ended', { exitCode: code ?? 0 })
      sse.broadcastStatus('waiting_for_session')

      console.log('   Bridge waiting for next session...')
    })
  }

  // -----------------------------------------------------------------------
  // 7. Handle --continue / --resume auto-start, or broadcast waiting status
  // -----------------------------------------------------------------------
  if (args.continue) {
    // Auto-start: find most recent session and spawn with --continue
    const sessions = await scanSessions()
    if (sessions.length === 0) {
      console.log('   No existing sessions found. Starting new session...')
      const proc = await pm.start(process.cwd(), { mode: 'new' })
      wireSession(proc)
    } else {
      const latest = sessions[0]
      console.log(`   Continuing session: ${latest.shortId} (${latest.project})`)
      const proc = await pm.start(latest.cwd, { mode: 'continue' })
      wireSession(proc, latest.id)
    }
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
    const proc = await pm.start(target.cwd, { mode: 'resume', sessionId: target.id })
    wireSession(proc, target.id)
  } else {
    // Default: wait for web UI POST /sessions/start
    console.log('   Bridge started — waiting for session start via web UI')
    sse.broadcastStatus('waiting_for_session')
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
