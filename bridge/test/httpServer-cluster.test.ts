/**
 * Tests for cluster-routing endpoints in httpServer.ts.
 *
 * Covers:
 *   POST /cluster/register
 *   POST /cluster/heartbeat
 *   GET  /cluster/status
 *   GET  /cluster/sessions (cached + refresh)
 *   POST /cluster/action
 *   POST /cluster/message
 *
 * Strategy: start a real HTTP server with a real ClusterManager but an injected
 * fetch mock so proxy calls don't escape the test process.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import { startHttpServer } from '../src/httpServer.js'
import { createClusterManager } from '../src/clusterManager.js'
import type { ClusterManager } from '../src/clusterManager.js'
import { createClusterProxy } from '../src/clusterProxy.js'

const CLUSTER_TOKEN = 'rcc_cluster_test'
const SESSION_TOKEN = 'rcc_session_test'

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response
}

describe('httpServer /cluster/* endpoints', () => {
  let server: HttpServer | undefined
  let baseUrl: string
  let cluster: ClusterManager
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    cluster = await createClusterManager({
      noPersist: true,
      self: {
        machineId: 'server-id',
        name: 'Server',
        url: 'http://server.local:7860',
        sessionToken: 'server-tok',
      },
    })
    fetchMock = vi.fn()
    const proxy = createClusterProxy({ cluster, fetchImpl: fetchMock })
    const result = await startHttpServer(0, {
      authToken: SESSION_TOKEN,
      clusterManager: cluster,
      clusterProxy: proxy,
      clusterToken: CLUSTER_TOKEN,
      fetchImpl: fetchMock,
    })
    server = result.server
    const port = new URL(result.url).port
    baseUrl = `http://localhost:${port}`
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()))
      server = undefined
    }
    await cluster.close()
  })

  // -----------------------------------------------------------------------
  // Auth gate
  // -----------------------------------------------------------------------

  it('returns 401 without cluster token', async () => {
    const res = await fetch(`${baseUrl}/cluster/status`)
    expect(res.status).toBe(401)
  })

  it('returns 401 with wrong cluster token', async () => {
    const res = await fetch(`${baseUrl}/cluster/status`, {
      headers: { 'Authorization': 'Bearer nope' },
    })
    expect(res.status).toBe(401)
  })

  // -----------------------------------------------------------------------
  // POST /cluster/register
  // -----------------------------------------------------------------------

  it('POST /cluster/register stores machine state', async () => {
    const res = await fetch(`${baseUrl}/cluster/register`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLUSTER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        machineId: 'client-1',
        name: 'Client One',
        url: 'http://client1.local:7860',
        sessionToken: 'client-tok-1',
      }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)

    const m = cluster.getMachine('client-1')
    expect(m?.name).toBe('Client One')
  })

  it('POST /cluster/register returns 400 on invalid body', async () => {
    const res = await fetch(`${baseUrl}/cluster/register`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLUSTER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ machineId: '', name: 'x', url: 'http://x', sessionToken: 'y' }),
    })
    expect(res.status).toBe(400)
  })

  // -----------------------------------------------------------------------
  // POST /cluster/heartbeat
  // -----------------------------------------------------------------------

  it('POST /cluster/heartbeat returns 404 for unknown machine', async () => {
    const res = await fetch(`${baseUrl}/cluster/heartbeat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLUSTER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        machineId: 'nobody',
        sessionToken: 'x',
        status: 'idle',
      }),
    })
    expect(res.status).toBe(404)
  })

  it('POST /cluster/heartbeat returns 401 on wrong sessionToken', async () => {
    cluster.register({
      machineId: 'client-1',
      name: 'Client',
      url: 'http://c1:7860',
      sessionToken: 'right',
    })
    const res = await fetch(`${baseUrl}/cluster/heartbeat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLUSTER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        machineId: 'client-1',
        sessionToken: 'wrong',
        status: 'idle',
      }),
    })
    expect(res.status).toBe(401)
  })

  it('POST /cluster/heartbeat updates machine status', async () => {
    cluster.register({
      machineId: 'client-1',
      name: 'Client',
      url: 'http://c1:7860',
      sessionToken: 'tok-1',
    })
    const res = await fetch(`${baseUrl}/cluster/heartbeat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLUSTER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        machineId: 'client-1',
        sessionToken: 'tok-1',
        status: 'running',
        sessionId: 'sess-xyz',
        project: 'demo',
      }),
    })
    expect(res.status).toBe(200)
    const m = cluster.getMachine('client-1')
    expect(m?.status).toBe('running')
    expect(m?.sessionId).toBe('sess-xyz')
  })

  // -----------------------------------------------------------------------
  // GET /cluster/status
  // -----------------------------------------------------------------------

  it('GET /cluster/status returns all machines including self, with sessionTokens stripped', async () => {
    cluster.register({
      machineId: 'client-1',
      name: 'Client One',
      url: 'http://c1:7860',
      sessionToken: 'tok-1',
    })
    const res = await fetch(`${baseUrl}/cluster/status`, {
      headers: { 'Authorization': `Bearer ${CLUSTER_TOKEN}` },
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { machines: Array<Record<string, unknown>> }
    const ids = json.machines.map((m) => m.machineId as string).sort()
    expect(ids).toContain('client-1')
    expect(ids).toContain('server-id')
    // SECURITY: sessionToken must NEVER appear in the response
    for (const m of json.machines) {
      expect(m.sessionToken).toBeUndefined()
    }
    // Raw JSON text should also not contain the token strings
    const raw = JSON.stringify(json)
    expect(raw).not.toContain('tok-1')
    expect(raw).not.toContain('server-tok')
  })

  // -----------------------------------------------------------------------
  // GET /cluster/sessions (cached + refresh)
  // -----------------------------------------------------------------------

  it('GET /cluster/sessions aggregates from heartbeat cache by default', async () => {
    cluster.register({
      machineId: 'client-1',
      name: 'Client One',
      url: 'http://c1:7860',
      sessionToken: 'tok-1',
    })
    cluster.heartbeat({
      machineId: 'client-1',
      sessionToken: 'tok-1',
      status: 'idle',
      sessions: [
        { id: 'sess-1', shortId: 'ss01', project: 'p1', cwd: '/p1', time: '2026-04-18T10:00:00Z', summary: 's1' },
      ],
    })
    const res = await fetch(`${baseUrl}/cluster/sessions`, {
      headers: { 'Authorization': `Bearer ${CLUSTER_TOKEN}` },
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { sessions: Array<{ id: string; machineId: string }> }
    expect(json.sessions).toHaveLength(1)
    expect(json.sessions[0]).toMatchObject({ id: 'sess-1', machineId: 'client-1', machineName: 'Client One' })
  })

  it('GET /cluster/sessions?refresh=true caches result for 5s — second refresh hits cache, no new fetches', async () => {
    cluster.register({
      machineId: 'client-1',
      name: 'Client One',
      url: 'http://c1:7860',
      sessionToken: 'tok-1',
    })
    // Count per-target /sessions/history fetches. Self (server-id) is also
    // in listMachines so a single fan-out fires 2 fetches (server + client).
    let historyFetches = 0
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/sessions/history')) {
        historyFetches++
        return makeResponse({ sessions: [{ id: 'live', shortId: 'lv', project: 'p', cwd: '/p', time: '2026-04-18T10:00:00Z', summary: '' }] })
      }
      return makeResponse({}, 404)
    })

    const r1 = await fetch(`${baseUrl}/cluster/sessions?refresh=true`, {
      headers: { 'Authorization': `Bearer ${CLUSTER_TOKEN}` },
    })
    expect(r1.status).toBe(200)
    const firstCount = historyFetches
    expect(firstCount).toBeGreaterThan(0)

    // Second refresh immediately — must reuse the cache (zero new fetches)
    const r2 = await fetch(`${baseUrl}/cluster/sessions?refresh=true`, {
      headers: { 'Authorization': `Bearer ${CLUSTER_TOKEN}` },
    })
    expect(r2.status).toBe(200)
    // CRITICAL: no new fetches on the cache-hit path
    expect(historyFetches).toBe(firstCount)

    const j2 = await r2.json() as { sessions: Array<{ id: string }> }
    expect(j2.sessions.some((s) => s.id === 'live')).toBe(true)
  })

  it('concurrent refresh=true calls share a single fan-out (in-flight guard)', async () => {
    cluster.register({
      machineId: 'client-1',
      name: 'Client One',
      url: 'http://c1:7860',
      sessionToken: 'tok-1',
    })
    let historyFetches = 0
    let resolveFanout: (() => void) | null = null
    const fanoutGate = new Promise<void>((r) => { resolveFanout = r })
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/sessions/history')) {
        historyFetches++
        await fanoutGate
        return makeResponse({ sessions: [] })
      }
      return makeResponse({}, 404)
    })

    // Fire 3 concurrent refresh requests while the fan-out is parked
    const p1 = fetch(`${baseUrl}/cluster/sessions?refresh=true`, {
      headers: { 'Authorization': `Bearer ${CLUSTER_TOKEN}` },
    })
    const p2 = fetch(`${baseUrl}/cluster/sessions?refresh=true`, {
      headers: { 'Authorization': `Bearer ${CLUSTER_TOKEN}` },
    })
    const p3 = fetch(`${baseUrl}/cluster/sessions?refresh=true`, {
      headers: { 'Authorization': `Bearer ${CLUSTER_TOKEN}` },
    })

    await new Promise((r) => setTimeout(r, 50))
    const parkedCount = historyFetches // should reflect ONE fan-out's worth of targets
    resolveFanout!()

    await Promise.all([p1, p2, p3])
    // After releasing, total fetches equals the first fan-out's parked count:
    // the second and third refresh calls piggy-backed on the in-flight promise
    // instead of triggering fresh fetches. So total === parkedCount (not 3×).
    expect(historyFetches).toBe(parkedCount)
  })

  it('GET /cluster/sessions?refresh=true fans out to online clients', async () => {
    cluster.register({
      machineId: 'client-1',
      name: 'Client One',
      url: 'http://c1:7860',
      sessionToken: 'tok-1',
    })
    // Mock fan-out response
    fetchMock.mockResolvedValueOnce(makeResponse({
      sessions: [
        { id: 'live-1', shortId: 'lv01', project: 'proj', cwd: '/x', time: '2026-04-18T11:00:00Z', summary: 'live' },
      ],
    }))
    const res = await fetch(`${baseUrl}/cluster/sessions?refresh=true`, {
      headers: { 'Authorization': `Bearer ${CLUSTER_TOKEN}` },
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { sessions: Array<{ id: string }> }
    expect(json.sessions.some((s) => s.id === 'live-1')).toBe(true)
    // fetch was called with the client's bearer
    expect(fetchMock).toHaveBeenCalledWith(
      'http://c1:7860/sessions/history',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Authorization': 'Bearer tok-1' }),
      }),
    )
  })

  // -----------------------------------------------------------------------
  // POST /cluster/action
  // -----------------------------------------------------------------------

  it('POST /cluster/action forwards start_session to target', async () => {
    cluster.register({
      machineId: 'client-1',
      name: 'Client',
      url: 'http://c1:7860',
      sessionToken: 'tok-1',
    })
    fetchMock.mockResolvedValueOnce(makeResponse({ ok: true, sessionId: 'abc' }))
    const res = await fetch(`${baseUrl}/cluster/action`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLUSTER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        machineId: 'client-1',
        action: 'start_session',
        sessionId: 'abc',
      }),
    })
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://c1:7860/sessions/start',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Authorization': 'Bearer tok-1' }),
      }),
    )
  })

  it('POST /cluster/action returns 400 on invalid action', async () => {
    const res = await fetch(`${baseUrl}/cluster/action`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLUSTER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ machineId: 'x', action: 'delete_universe' }),
    })
    expect(res.status).toBe(400)
  })

  // -----------------------------------------------------------------------
  // POST /cluster/message
  // -----------------------------------------------------------------------

  it('POST /cluster/message proxies to target /messages', async () => {
    cluster.register({
      machineId: 'client-1',
      name: 'Client',
      url: 'http://c1:7860',
      sessionToken: 'tok-1',
    })
    fetchMock.mockResolvedValueOnce(makeResponse({ ok: true }))
    const res = await fetch(`${baseUrl}/cluster/message?machineId=client-1`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLUSTER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'user', text: 'hi' }),
    })
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://c1:7860/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Authorization': 'Bearer tok-1' }),
      }),
    )
  })

  it('POST /cluster/message returns 400 without machineId', async () => {
    const res = await fetch(`${baseUrl}/cluster/message`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLUSTER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  // -----------------------------------------------------------------------
  // Unknown route returns 404
  // -----------------------------------------------------------------------

  it('returns 404 on unknown /cluster/* route', async () => {
    const res = await fetch(`${baseUrl}/cluster/nonsense`, {
      headers: { 'Authorization': `Bearer ${CLUSTER_TOKEN}` },
    })
    expect(res.status).toBe(404)
  })
})

describe('httpServer without cluster mode', () => {
  let server: HttpServer | undefined
  let baseUrl: string

  beforeEach(async () => {
    const result = await startHttpServer(0, { authToken: SESSION_TOKEN })
    server = result.server
    const port = new URL(result.url).port
    baseUrl = `http://localhost:${port}`
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()))
      server = undefined
    }
  })

  it('returns 404 "Cluster mode not enabled" when no clusterManager configured', async () => {
    const res = await fetch(`${baseUrl}/cluster/status`)
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toMatch(/not enabled/i)
  })
})
