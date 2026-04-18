/**
 * Tests for clusterManager.ts — machine state cache and timeout detection.
 *
 * factory is async (awaits persisted state load).
 * heartbeat requires sessionToken (identity proof).
 * register returns { ok, error? }.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, unlink } from 'node:fs/promises'
import { createClusterManager } from '../src/clusterManager.js'
import type { RegisterRequest, HeartbeatRequest } from '../src/clusterManager.js'

const TOKEN = 'tok-abc'

function makeRegReq(overrides?: Partial<RegisterRequest>): RegisterRequest {
  return {
    machineId: 'machine-a',
    name: 'Alpha',
    url: 'http://localhost:7860',
    sessionToken: TOKEN,
    ...overrides,
  }
}

function makeHbReq(overrides?: Partial<HeartbeatRequest>): HeartbeatRequest {
  return {
    machineId: 'machine-a',
    sessionToken: TOKEN,
    status: 'idle',
    ...overrides,
  }
}

// -----------------------------------------------------------------------
// register()
// -----------------------------------------------------------------------

describe('register()', () => {
  it('stores machine state and returns ok', async () => {
    const mgr = await createClusterManager({ noPersist: true })
    const result = mgr.register(makeRegReq())

    expect(result.ok).toBe(true)
    const machine = mgr.getMachine('machine-a')
    expect(machine).toBeDefined()
    expect(machine?.name).toBe('Alpha')
    expect(machine?.url).toBe('http://localhost:7860')
    expect(machine?.status).toBe('idle')
    await mgr.close()
  })

  it('preserves firstSeen on re-registration with same token', async () => {
    vi.useFakeTimers()
    const mgr = await createClusterManager({ noPersist: true })

    vi.setSystemTime(1000)
    mgr.register(makeRegReq())
    const firstSeen = mgr.getMachine('machine-a')!.firstSeen

    vi.setSystemTime(5000)
    const result = mgr.register(makeRegReq({ name: 'Alpha Updated' }))
    expect(result.ok).toBe(true)

    const machine = mgr.getMachine('machine-a')!
    expect(machine.firstSeen).toBe(firstSeen)
    expect(machine.name).toBe('Alpha Updated')
    expect(machine.lastSeen).toBe(5000)

    vi.useRealTimers()
    await mgr.close()
  })

  it('stores optional os and hostname fields', async () => {
    const mgr = await createClusterManager({ noPersist: true })
    mgr.register(makeRegReq({ os: 'darwin', hostname: 'my-mac.local' }))

    const machine = mgr.getMachine('machine-a')
    expect(machine?.os).toBe('darwin')
    expect(machine?.hostname).toBe('my-mac.local')
    await mgr.close()
  })

  it('rejects re-registration with a different sessionToken (impersonation guard)', async () => {
    const mgr = await createClusterManager({ noPersist: true })
    mgr.register(makeRegReq({ sessionToken: 'original' }))

    const attacker = mgr.register(makeRegReq({ sessionToken: 'attacker' }))
    expect(attacker.ok).toBe(false)
    expect(attacker.error).toMatch(/sessionToken/)

    // Original session still intact
    expect(mgr.getMachine('machine-a')?.sessionToken).toBe('original')
    await mgr.close()
  })

  it('rejects registration that conflicts with server self', async () => {
    const mgr = await createClusterManager({
      noPersist: true,
      self: { machineId: 'srv', name: 'Server', url: 'http://srv', sessionToken: 'srv-tok' },
    })
    const result = mgr.register(makeRegReq({ machineId: 'srv' }))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/conflicts with server self/)
    await mgr.close()
  })
})

// -----------------------------------------------------------------------
// register() — URL & field validation
// -----------------------------------------------------------------------

describe('register() validation', () => {
  it('returns error for non-URL string', async () => {
    const mgr = await createClusterManager({ noPersist: true })
    const r = mgr.register(makeRegReq({ url: 'not-a-url' }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid URL/)
    await mgr.close()
  })

  it('returns error for ftp:// URL', async () => {
    const mgr = await createClusterManager({ noPersist: true })
    const r = mgr.register(makeRegReq({ url: 'ftp://host/path' }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/http/)
    await mgr.close()
  })

  it('accepts https:// URL', async () => {
    const mgr = await createClusterManager({ noPersist: true })
    expect(mgr.register(makeRegReq({ url: 'https://example.com:8080' })).ok).toBe(true)
    await mgr.close()
  })

  it('returns error for empty machineId', async () => {
    const mgr = await createClusterManager({ noPersist: true })
    const r = mgr.register(makeRegReq({ machineId: '' }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/machineId/)
    await mgr.close()
  })

  it('returns error for empty name', async () => {
    const mgr = await createClusterManager({ noPersist: true })
    const r = mgr.register(makeRegReq({ name: '' }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/name/)
    await mgr.close()
  })

  it('returns error for empty sessionToken', async () => {
    const mgr = await createClusterManager({ noPersist: true })
    const r = mgr.register(makeRegReq({ sessionToken: '' }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/sessionToken/)
    await mgr.close()
  })
})

// -----------------------------------------------------------------------
// heartbeat()
// -----------------------------------------------------------------------

describe('heartbeat()', () => {
  it('updates status, sessionId, project, sessions, lastSeen on valid token', async () => {
    vi.useFakeTimers()
    const mgr = await createClusterManager({ noPersist: true })

    vi.setSystemTime(1000)
    mgr.register(makeRegReq())

    vi.setSystemTime(2000)
    const result = mgr.heartbeat(makeHbReq({
      status: 'running',
      sessionId: 'sess-xyz',
      project: 'my-project',
      sessions: [{ id: 'sess-xyz', shortId: 'ssxy', project: 'my-project', cwd: '/path', time: new Date().toISOString(), summary: 'hello' }],
    }))

    expect(result).toEqual({ ok: true })
    const machine = mgr.getMachine('machine-a')!
    expect(machine.status).toBe('running')
    expect(machine.sessionId).toBe('sess-xyz')
    expect(machine.project).toBe('my-project')
    expect(machine.sessions).toHaveLength(1)
    expect(machine.lastSeen).toBe(2000)

    vi.useRealTimers()
    await mgr.close()
  })

  it('brings offline machine back online', async () => {
    vi.useFakeTimers()
    const mgr = await createClusterManager({
      noPersist: true,
      offlineTimeoutMs: 1000,
      sweepIntervalMs: 500,
    })

    vi.setSystemTime(0)
    mgr.register(makeRegReq())
    vi.advanceTimersByTime(2000)
    expect(mgr.getMachine('machine-a')?.status).toBe('offline')

    vi.setSystemTime(3000)
    mgr.heartbeat(makeHbReq({ status: 'idle' }))
    expect(mgr.getMachine('machine-a')?.status).toBe('idle')

    vi.useRealTimers()
    await mgr.close()
  })

  it('keeps previous optional fields when new heartbeat omits them', async () => {
    const mgr = await createClusterManager({ noPersist: true })
    mgr.register(makeRegReq())
    mgr.heartbeat(makeHbReq({ status: 'running', sessionId: 'sess-1', project: 'proj-a' }))
    mgr.heartbeat(makeHbReq({ status: 'idle' }))

    const machine = mgr.getMachine('machine-a')!
    expect(machine.sessionId).toBe('sess-1')
    expect(machine.project).toBe('proj-a')
    expect(machine.status).toBe('idle')
    await mgr.close()
  })

  it('rejects heartbeat for unknown machineId', async () => {
    const mgr = await createClusterManager({ noPersist: true })
    const result = mgr.heartbeat(makeHbReq({ machineId: 'unknown-id' }))
    expect(result).toEqual({ ok: false, error: 'not registered' })
    await mgr.close()
  })

  it('rejects heartbeat with wrong sessionToken', async () => {
    const mgr = await createClusterManager({ noPersist: true })
    mgr.register(makeRegReq({ sessionToken: 'original' }))
    const result = mgr.heartbeat(makeHbReq({ sessionToken: 'wrong' }))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/sessionToken/)
    await mgr.close()
  })

  it('rejects heartbeat missing sessionToken', async () => {
    const mgr = await createClusterManager({ noPersist: true })
    mgr.register(makeRegReq())
    const result = mgr.heartbeat({ machineId: 'machine-a', sessionToken: '', status: 'idle' })
    expect(result.ok).toBe(false)
    await mgr.close()
  })
})

// -----------------------------------------------------------------------
// listMachines()
// -----------------------------------------------------------------------

describe('listMachines()', () => {
  it('returns machines sorted by name ascending', async () => {
    const mgr = await createClusterManager({ noPersist: true })
    mgr.register(makeRegReq({ machineId: 'id-c', name: 'Charlie' }))
    mgr.register(makeRegReq({ machineId: 'id-a', name: 'Alpha' }))
    mgr.register(makeRegReq({ machineId: 'id-b', name: 'Bravo' }))

    const names = mgr.listMachines().map((m) => m.name)
    expect(names).toEqual(['Alpha', 'Bravo', 'Charlie'])
    await mgr.close()
  })

  it('includes self entry when configured', async () => {
    const mgr = await createClusterManager({
      noPersist: true,
      self: { machineId: 'server-self', name: 'Server', url: 'http://server:7860', sessionToken: 'server-tok' },
    })
    mgr.register(makeRegReq({ machineId: 'client-1', name: 'Client' }))

    const ids = mgr.listMachines().map((m) => m.machineId)
    expect(ids).toContain('server-self')
    expect(ids).toContain('client-1')
    await mgr.close()
  })

  it('self entry is always idle even after timeout', async () => {
    vi.useFakeTimers()
    const mgr = await createClusterManager({
      noPersist: true,
      offlineTimeoutMs: 1000,
      sweepIntervalMs: 500,
      self: { machineId: 'srv', name: 'Server', url: 'http://server:7860', sessionToken: 'tok' },
    })

    vi.advanceTimersByTime(5000)
    const self = mgr.listMachines().find((m) => m.machineId === 'srv')
    expect(self?.status).toBe('idle')

    vi.useRealTimers()
    await mgr.close()
  })

  it('getMachine(selfId) returns idle even after timeout', async () => {
    vi.useFakeTimers()
    const mgr = await createClusterManager({
      noPersist: true,
      offlineTimeoutMs: 1000,
      sweepIntervalMs: 500,
      self: { machineId: 'srv', name: 'Server', url: 'http://server:7860', sessionToken: 'tok' },
    })

    vi.advanceTimersByTime(5000)
    // getMachine(selfId) should also return idle per spec
    const self = mgr.getMachine('srv')
    expect(self?.status).toBe('idle')

    vi.useRealTimers()
    await mgr.close()
  })

  it('self lastSeen refreshes on each listMachines() call', async () => {
    vi.useFakeTimers()
    const mgr = await createClusterManager({
      noPersist: true,
      self: { machineId: 'srv', name: 'Server', url: 'http://srv:7860', sessionToken: 'tok' },
    })

    vi.setSystemTime(1000)
    const first = mgr.listMachines().find((m) => m.machineId === 'srv')!.lastSeen

    vi.setSystemTime(2000)
    const second = mgr.listMachines().find((m) => m.machineId === 'srv')!.lastSeen

    expect(second).toBeGreaterThan(first)

    vi.useRealTimers()
    await mgr.close()
  })
})

// -----------------------------------------------------------------------
// offline detection
// -----------------------------------------------------------------------

describe('offline detection', () => {
  it('marks machine offline strictly AFTER offlineTimeoutMs (not equal)', async () => {
    vi.useFakeTimers()
    const mgr = await createClusterManager({
      noPersist: true,
      offlineTimeoutMs: 1000,
      sweepIntervalMs: 500,
    })

    vi.setSystemTime(0)
    mgr.register(makeRegReq())

    // At 1000ms (= threshold): still idle (sweep uses > not >=)
    vi.advanceTimersByTime(1000)
    expect(mgr.getMachine('machine-a')?.status).toBe('idle')

    // Just past: 1500ms > 1000ms → offline
    vi.advanceTimersByTime(500)
    expect(mgr.getMachine('machine-a')?.status).toBe('offline')

    vi.useRealTimers()
    await mgr.close()
  })

  it('does not mark machine offline if it keeps sending heartbeats', async () => {
    vi.useFakeTimers()
    const mgr = await createClusterManager({
      noPersist: true,
      offlineTimeoutMs: 1000,
      sweepIntervalMs: 500,
    })

    vi.setSystemTime(0)
    mgr.register(makeRegReq())

    for (let t = 400; t <= 3000; t += 400) {
      vi.setSystemTime(t)
      mgr.heartbeat(makeHbReq({ status: 'idle' }))
      vi.advanceTimersByTime(400)
    }

    expect(mgr.getMachine('machine-a')?.status).toBe('idle')

    vi.useRealTimers()
    await mgr.close()
  })
})

// -----------------------------------------------------------------------
// persistence round-trip
// -----------------------------------------------------------------------

describe('persistence round-trip', () => {
  const tmpFile = join(tmpdir(), `cluster-test-${process.pid}-${Date.now()}.json`)

  afterEach(async () => {
    try {
      await unlink(tmpFile)
    } catch {
      // ignore
    }
  })

  it('restores state after close + reload (all entries start as offline)', async () => {
    const mgr1 = await createClusterManager({
      persistPath: tmpFile,
      persistDebounceMs: 0,
    })
    mgr1.register(makeRegReq({ machineId: 'mc-1', name: 'Machine One' }))
    mgr1.register(makeRegReq({ machineId: 'mc-2', name: 'Machine Two' }))
    mgr1.heartbeat({ machineId: 'mc-1', sessionToken: TOKEN, status: 'running', project: 'proj-a' })
    await mgr1.close()

    const raw = await readFile(tmpFile, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.version).toBe(1)
    expect(Object.keys(parsed.machines)).toHaveLength(2)

    // Load in new manager — async factory awaits load before returning
    const mgr2 = await createClusterManager({
      persistPath: tmpFile,
      persistDebounceMs: 100_000,
    })

    const mc1 = mgr2.getMachine('mc-1')
    const mc2 = mgr2.getMachine('mc-2')
    expect(mc1?.status).toBe('offline')
    expect(mc2?.status).toBe('offline')
    expect(mc1?.name).toBe('Machine One')
    expect(mc2?.name).toBe('Machine Two')
    expect(mc1?.project).toBe('proj-a')

    await mgr2.close()
  })

  it('does not crash if persist file does not exist', async () => {
    const nonExistentPath = join(tmpdir(), `no-such-file-${Date.now()}.json`)
    const mgr = await createClusterManager({ persistPath: nonExistentPath })
    expect(mgr.listMachines()).toEqual([])
    await mgr.close()
  })

  it('does not persist self entry even if its machineId happens to be in the map', async () => {
    // First manager creates and persists two clients
    const mgr1 = await createClusterManager({
      persistPath: tmpFile,
      persistDebounceMs: 0,
      self: { machineId: 'srv', name: 'Server', url: 'http://srv:7860', sessionToken: 'srv-tok' },
    })
    mgr1.register(makeRegReq({ machineId: 'client-a', name: 'Client A' }))
    mgr1.listMachines() // triggers self injection into the map

    await mgr1.close()

    const raw = await readFile(tmpFile, 'utf8')
    const parsed = JSON.parse(raw)
    // Self should NOT be in persisted machines
    expect(parsed.machines['srv']).toBeUndefined()
    // Client A should be
    expect(parsed.machines['client-a']).toBeDefined()
  })

  it('ignores persisted entry that shadows current self machineId', async () => {
    // Pretend an old server run persisted "srv" as a regular machine
    const { writeFile, mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(tmpFile), { recursive: true })
    await writeFile(tmpFile, JSON.stringify({
      version: 1,
      machines: {
        'srv': {
          machineId: 'srv', name: 'Old Server', url: 'http://old:7860',
          sessionToken: 'old-tok', status: 'offline', sessions: [],
          lastSeen: 0, firstSeen: 0,
        },
      },
    }))

    const mgr = await createClusterManager({
      persistPath: tmpFile,
      self: { machineId: 'srv', name: 'New Server', url: 'http://new:7860', sessionToken: 'new-tok' },
    })

    // Self should come from options, NOT from disk
    const self = mgr.listMachines().find((m) => m.machineId === 'srv')
    expect(self?.name).toBe('New Server')
    expect(self?.url).toBe('http://new:7860')
    expect(self?.sessionToken).toBe('new-tok')
    expect(self?.status).toBe('idle')

    await mgr.close()
  })
})
