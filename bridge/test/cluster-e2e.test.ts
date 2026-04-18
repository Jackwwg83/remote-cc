/**
 * End-to-end cluster integration test (T-M12).
 *
 * Spins up two in-process HTTP servers — one playing the server role and
 * one playing the client role — and walks the full cross-machine flow:
 *
 *   1. client registers with server
 *   2. client heartbeat updates server's state cache
 *   3. /cluster/status lists both machines (sessionToken redacted)
 *   4. /cluster/sessions aggregates heartbeat cache
 *   5. /cluster/action proxies start/stop to client's /sessions/*
 *   6. /cluster/message proxies to client's /messages
 *   7. /cluster/stream pipes SSE from client through server
 *
 * Uses a fake ProcessManager on the client side so we don't spawn claude.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import { startHttpServer } from '../src/httpServer.js'
import { createClusterManager } from '../src/clusterManager.js'
import type { ClusterManager } from '../src/clusterManager.js'
import { createClusterProxy } from '../src/clusterProxy.js'
import { createClusterClient } from '../src/clusterClient.js'
import type { ClusterClient } from '../src/clusterClient.js'
import type { ProcessManager, ProcessState } from '../src/processManager.js'
import type { ClaudeProcess } from '../src/spawner.js'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createSseWriter } from '../src/sseWriter.js'
import { createMessageCache } from '../src/messageCache.js'

const CLUSTER_TOKEN = 'rcc_cluster_e2e'

// ---------------------------------------------------------------------------
// Fake ProcessManager — doesn't spawn claude
// ---------------------------------------------------------------------------

function makeFakeProc(): ClaudeProcess {
  const ee = new EventEmitter() as unknown as ClaudeProcess
  ;(ee as unknown as { stdout: PassThrough }).stdout = new PassThrough()
  ;(ee as unknown as { stdin: PassThrough }).stdin = new PassThrough()
  ;(ee as unknown as { kill: () => void }).kill = () => { ee.emit('exit', 0) }
  ;(ee as unknown as { forceKill: () => void }).forceKill = () => { ee.emit('exit', 137) }
  return ee
}

interface FakePM extends ProcessManager {
  startCalls: Array<{ cwd: string; sessionId?: string }>
  stopCalls: number
}

function makeFakePM(): FakePM {
  let state: ProcessState = 'idle'
  let currentSession: string | undefined
  let currentProc: ClaudeProcess | null = null
  const startCalls: Array<{ cwd: string; sessionId?: string }> = []
  let stopCalls = 0
  return {
    get state() { return state },
    get sessionId() { return currentSession },
    get process() { return currentProc },
    async start(cwd, opts) {
      startCalls.push({ cwd, sessionId: opts?.sessionId })
      state = 'running'
      currentSession = opts?.sessionId
      currentProc = makeFakeProc()
      return currentProc
    },
    async stop() {
      stopCalls++
      state = 'idle'
      if (currentProc) currentProc.kill()
      currentProc = null
      currentSession = undefined
    },
    get startCalls() { return startCalls },
    get stopCalls() { return stopCalls },
  } as unknown as FakePM
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Harness {
  serverManager: ClusterManager
  serverHttp: HttpServer
  serverUrl: string
  serverSessionToken: string
  serverScanCalls: { count: number }
  clientHttp: HttpServer
  clientUrl: string
  clientSessionToken: string
  clientId: string
  clientPM: FakePM
  clientReceivedMessages: unknown[]
  clientSseWriter: ReturnType<typeof createSseWriter>['writer']
  clusterClient: ClusterClient | null
}

async function setup(): Promise<Harness> {
  const serverSessionToken = 'rcc_srv_sess'
  const clientSessionToken = 'rcc_cli_sess'

  // ----- Server bridge (HTTP first so we know the port for self.url) -----
  // We create a placeholder manager, start HTTP with a temporary slot, then
  // attach the real manager once we know the port. But startHttpServer
  // requires clusterManager upfront — so spin up HTTP with a dummy, read
  // port, close, recreate manager+HTTP. Simpler: pick a random ephemeral
  // port via portfinder-style approach (start on 0, read addr, recycle).
  const tempManager = await createClusterManager({ noPersist: true })
  const tempProxy = createClusterProxy({ cluster: tempManager })
  const { server: tempServer, url: tempUrl } = await startHttpServer(0, {
    clusterManager: tempManager,
    clusterProxy: tempProxy,
    clusterToken: CLUSTER_TOKEN,
  })
  const serverPort = new URL(tempUrl).port
  await new Promise<void>((r) => tempServer.close(() => r()))
  await tempManager.close()

  const serverManager = await createClusterManager({
    noPersist: true,
    self: {
      machineId: 'srv-id',
      name: 'Server',
      url: `http://localhost:${serverPort}`,
      sessionToken: serverSessionToken,
    },
  })
  const serverProxy = createClusterProxy({ cluster: serverManager })
  const serverScanCalls = { count: 0 }
  const { server: serverHttp } = await startHttpServer(parseInt(serverPort, 10), {
    authToken: serverSessionToken,
    scanSessions: async () => {
      serverScanCalls.count++
      return [
        { id: 'sess-server-1', shortId: 'sv01', project: 'srv-proj', cwd: '/srv', time: '2026-04-18T09:00:00Z', summary: 'server-local session' },
      ]
    },
    clusterManager: serverManager,
    clusterProxy: serverProxy,
    clusterToken: CLUSTER_TOKEN,
  })

  // ----- Client bridge -----
  const clientId = 'cli-id'
  const cache = createMessageCache(200)
  const { writer: sse, handleSseRequest } = createSseWriter({
    authToken: clientSessionToken,
    messageCache: cache,
    getSessionState: () => ({ state: 'waiting_for_session' }),
  })
  const pm = makeFakePM()
  const clientReceivedMessages: unknown[] = []
  let currentMessageHandler: ((msg: Record<string, unknown>) => boolean) | null = null
  const { server: clientHttp, url: clientUrl } = await startHttpServer(0, {
    authToken: clientSessionToken,
    processManager: pm,
    scanSessions: async () => [
      { id: 'sess-e2e-1', shortId: 'se1', project: 'e2e', cwd: '/e2e', time: '2026-04-18T10:00:00Z', summary: 'e2e test session' },
    ],
    sseHandler: handleSseRequest,
    onSessionStarted: (proc) => {
      // Install a message-capturing handler
      currentMessageHandler = (msg) => { clientReceivedMessages.push(msg); return true }
      // Broadcast an "init" event so the proxy has something to pipe back
      setImmediate(() => sse.broadcast(1, JSON.stringify({ type: 'system', subtype: 'init', hello: 'e2e' })))
      proc.once('exit', () => { currentMessageHandler = null })
    },
    onMessageReceived: (msg) => {
      if (!currentMessageHandler) return false
      return currentMessageHandler(msg)
    },
    machineId: clientId,
  })
  const clientPort = new URL(clientUrl).port

  // Localhost replacement — HTTP servers bind 0.0.0.0 but fetches resolve via localhost
  const serverLocal = `http://localhost:${serverPort}`
  const clientLocal = `http://localhost:${clientPort}`

  return {
    serverManager,
    serverHttp,
    serverUrl: serverLocal,
    serverSessionToken,
    serverScanCalls,
    clientHttp,
    clientUrl: clientLocal,
    clientSessionToken,
    clientId,
    clientPM: pm,
    clientReceivedMessages,
    clientSseWriter: sse,
    clusterClient: null,
  }
}

async function teardown(h: Harness): Promise<void> {
  if (h.clusterClient) await h.clusterClient.close()
  await new Promise<void>((r) => h.serverHttp.close(() => r()))
  await new Promise<void>((r) => h.clientHttp.close(() => r()))
  await h.serverManager.close()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cluster E2E (2 machines in-process)', () => {
  let h: Harness

  beforeEach(async () => { h = await setup() })
  afterEach(async () => { await teardown(h) })

  it('client registers → server lists both machines (sessionToken redacted)', async () => {
    // Use the real clusterClient against a live server
    h.clusterClient = createClusterClient({
      serverUrl: h.serverUrl,
      clusterToken: CLUSTER_TOKEN,
      machineId: h.clientId,
      machineName: 'E2E Client',
      selfUrl: h.clientUrl,
      sessionToken: h.clientSessionToken,
      heartbeatIntervalMs: 60_000, // long — we only care about register here
    })
    await h.clusterClient.start()

    // Verify GET /cluster/status lists both + NO sessionToken leak
    const res = await fetch(`${h.serverUrl}/cluster/status`, {
      headers: { 'Authorization': `Bearer ${CLUSTER_TOKEN}` },
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { machines: Array<Record<string, unknown>> }
    const ids = json.machines.map((m) => m.machineId as string).sort()
    expect(ids).toContain('srv-id')
    expect(ids).toContain(h.clientId)
    for (const m of json.machines) {
      expect(m.sessionToken).toBeUndefined()
    }
    const raw = JSON.stringify(json)
    expect(raw).not.toContain(h.clientSessionToken)
    expect(raw).not.toContain(h.serverSessionToken)
  })

  it('heartbeat updates machine status → visible via /cluster/status', async () => {
    h.clusterClient = createClusterClient({
      serverUrl: h.serverUrl,
      clusterToken: CLUSTER_TOKEN,
      machineId: h.clientId,
      machineName: 'E2E Client',
      selfUrl: h.clientUrl,
      sessionToken: h.clientSessionToken,
      heartbeatIntervalMs: 100, // fast for test
    })
    await h.clusterClient.start()

    h.clusterClient.updateStatus({ status: 'running', sessionId: 'live-sess', project: 'live-proj' })
    // Wait for at least one heartbeat fire
    await new Promise((r) => setTimeout(r, 250))

    const m = h.serverManager.getMachine(h.clientId)
    expect(m).toBeDefined()
    expect(m?.status).toBe('running')
    expect(m?.sessionId).toBe('live-sess')
    expect(m?.project).toBe('live-proj')
  })

  it('/cluster/sessions?refresh=true fans out to BOTH client and server-self /sessions/history', async () => {
    h.clusterClient = createClusterClient({
      serverUrl: h.serverUrl,
      clusterToken: CLUSTER_TOKEN,
      machineId: h.clientId,
      machineName: 'E2E Client',
      selfUrl: h.clientUrl,
      sessionToken: h.clientSessionToken,
      heartbeatIntervalMs: 60_000,
    })
    await h.clusterClient.start()

    const scansBefore = h.serverScanCalls.count
    const res = await fetch(`${h.serverUrl}/cluster/sessions?refresh=true`, {
      headers: { 'Authorization': `Bearer ${CLUSTER_TOKEN}` },
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { sessions: Array<{ id: string; machineId: string }> }
    // Client's session must be present
    expect(json.sessions.some((s) => s.id === 'sess-e2e-1' && s.machineId === h.clientId)).toBe(true)
    // Server's OWN session must also be present (fan-out self-call worked)
    expect(json.sessions.some((s) => s.id === 'sess-server-1' && s.machineId === 'srv-id')).toBe(true)
    // Server scanSessions endpoint was actually hit by the fan-out
    expect(h.serverScanCalls.count).toBeGreaterThan(scansBefore)
  })

  it('POST /cluster/action forwards start_session → client ProcessManager actually started', async () => {
    h.clusterClient = createClusterClient({
      serverUrl: h.serverUrl,
      clusterToken: CLUSTER_TOKEN,
      machineId: h.clientId,
      machineName: 'E2E Client',
      selfUrl: h.clientUrl,
      sessionToken: h.clientSessionToken,
      heartbeatIntervalMs: 60_000,
    })
    await h.clusterClient.start()

    expect(h.clientPM.startCalls).toHaveLength(0)
    const res = await fetch(`${h.serverUrl}/cluster/action`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLUSTER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ machineId: h.clientId, action: 'start_session', sessionId: 'abc-123' }),
    })
    expect(res.status).toBe(200)
    // Downstream side effect: the client's fake PM saw start() called with sessionId
    expect(h.clientPM.startCalls).toHaveLength(1)
    expect(h.clientPM.startCalls[0].sessionId).toBe('abc-123')
    expect(h.clientPM.state).toBe('running')
  })

  it('POST /cluster/action for offline machine returns 404', async () => {
    // Don't register — machine doesn't exist
    const res = await fetch(`${h.serverUrl}/cluster/action`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLUSTER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ machineId: 'ghost-machine', action: 'start_session' }),
    })
    expect(res.status).toBe(404)
  })

  it('POST /cluster/message forwards to client /messages → message captured downstream', async () => {
    h.clusterClient = createClusterClient({
      serverUrl: h.serverUrl,
      clusterToken: CLUSTER_TOKEN,
      machineId: h.clientId,
      machineName: 'E2E Client',
      selfUrl: h.clientUrl,
      sessionToken: h.clientSessionToken,
      heartbeatIntervalMs: 60_000,
    })
    await h.clusterClient.start()

    // Start session so the handler is wired
    await fetch(`${h.serverUrl}/cluster/action`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CLUSTER_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ machineId: h.clientId, action: 'start_session' }),
    })

    const beforeCount = h.clientReceivedMessages.length
    const res = await fetch(`${h.serverUrl}/cluster/message?machineId=${h.clientId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CLUSTER_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'user', text: 'hi via proxy' }),
    })
    expect(res.status).toBe(200)
    // Downstream side effect: client's onMessageReceived handler actually saw the message
    expect(h.clientReceivedMessages.length).toBe(beforeCount + 1)
    expect(h.clientReceivedMessages[beforeCount]).toMatchObject({ type: 'user', text: 'hi via proxy' })
  })

  it('unauthorized proxy call returns 401 AND does not reach the client', async () => {
    h.clusterClient = createClusterClient({
      serverUrl: h.serverUrl,
      clusterToken: CLUSTER_TOKEN,
      machineId: h.clientId,
      machineName: 'E2E Client',
      selfUrl: h.clientUrl,
      sessionToken: h.clientSessionToken,
      heartbeatIntervalMs: 60_000,
    })
    await h.clusterClient.start()

    expect(h.clientPM.startCalls).toHaveLength(0)
    const res = await fetch(`${h.serverUrl}/cluster/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // no auth
      body: JSON.stringify({ machineId: h.clientId, action: 'start_session' }),
    })
    expect(res.status).toBe(401)
    // Downstream: client's PM must NOT have been called
    expect(h.clientPM.startCalls).toHaveLength(0)
  })

  it('GET /cluster/stream proxies SSE frames from client to caller', async () => {
    h.clusterClient = createClusterClient({
      serverUrl: h.serverUrl,
      clusterToken: CLUSTER_TOKEN,
      machineId: h.clientId,
      machineName: 'E2E Client',
      selfUrl: h.clientUrl,
      sessionToken: h.clientSessionToken,
      heartbeatIntervalMs: 60_000,
    })
    await h.clusterClient.start()

    // Kick off a stream request
    const controller = new AbortController()
    const streamResp = await fetch(`${h.serverUrl}/cluster/stream?machineId=${h.clientId}&token=${CLUSTER_TOKEN}`, {
      signal: controller.signal,
    })
    expect(streamResp.status).toBe(200)
    expect(streamResp.headers.get('content-type')).toMatch(/text\/event-stream/)

    // Wait for the proxy's fetch to actually land on the client's SSE
    // endpoint before broadcasting. sseWriter.broadcast() only writes to
    // currently-connected clients — without this readiness check, the
    // broadcast could race ahead of the proxy attach and be dropped.
    const attachDeadline = Date.now() + 2000
    while (h.clientSseWriter.clientCount() === 0 && Date.now() < attachDeadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(h.clientSseWriter.clientCount()).toBeGreaterThan(0)

    // Now the broadcast is guaranteed to reach the proxy
    h.clientSseWriter.broadcast(42, JSON.stringify({ type: 'system', subtype: 'init', hello: 'proxy' }))

    // Read some bytes from the stream
    const reader = streamResp.body!.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    const deadline = Date.now() + 2000
    while (!buffered.includes('proxy') && Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
    }
    expect(buffered).toContain('"hello":"proxy"')

    // Clean up — abort the stream
    controller.abort()
    try { await reader.cancel() } catch { /* already cancelling */ }
  })
})
