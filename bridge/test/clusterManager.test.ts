/**
 * Tests for clusterManager.ts — machine state cache and timeout detection.
 *
 * Uses noPersist: true for most tests to avoid touching disk.
 * Persistence round-trip tests use a tmp file path.
 * Fake timers (vi.useFakeTimers) are used to test the offline sweep.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, unlink } from 'node:fs/promises'
import { createClusterManager } from '../src/clusterManager.js'
import type { RegisterRequest, HeartbeatRequest } from '../src/clusterManager.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeRegReq(overrides?: Partial<RegisterRequest>): RegisterRequest {
  return {
    machineId: 'machine-a',
    name: 'Alpha',
    url: 'http://localhost:7860',
    sessionToken: 'tok-abc',
    ...overrides,
  }
}

function makeHbReq(overrides?: Partial<HeartbeatRequest>): HeartbeatRequest {
  return {
    machineId: 'machine-a',
    status: 'idle',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. register() stores machine state
// ---------------------------------------------------------------------------

describe('register()', () => {
  it('stores machine state and can retrieve it', () => {
    const mgr = createClusterManager({ noPersist: true })
    mgr.register(makeRegReq())

    const machine = mgr.getMachine('machine-a')
    expect(machine).toBeDefined()
    expect(machine?.name).toBe('Alpha')
    expect(machine?.url).toBe('http://localhost:7860')
    expect(machine?.sessionToken).toBe('tok-abc')
    expect(machine?.status).toBe('idle')
    expect(machine?.sessions).toEqual([])
    expect(typeof machine?.lastSeen).toBe('number')
    expect(typeof machine?.firstSeen).toBe('number')
  })

  it('preserves firstSeen on re-registration', async () => {
    vi.useFakeTimers()
    const mgr = createClusterManager({ noPersist: true })

    vi.setSystemTime(1000)
    mgr.register(makeRegReq())
    const firstSeen = mgr.getMachine('machine-a')!.firstSeen

    vi.setSystemTime(5000)
    mgr.register(makeRegReq({ name: 'Alpha Updated' }))

    const machine = mgr.getMachine('machine-a')!
    expect(machine.firstSeen).toBe(firstSeen)
    expect(machine.name).toBe('Alpha Updated')
    expect(machine.lastSeen).toBe(5000)

    vi.useRealTimers()
    await mgr.close()
  })

  it('stores optional os and hostname fields', () => {
    const mgr = createClusterManager({ noPersist: true })
    mgr.register(makeRegReq({ os: 'darwin', hostname: 'my-mac.local' }))

    const machine = mgr.getMachine('machine-a')
    expect(machine?.os).toBe('darwin')
    expect(machine?.hostname).toBe('my-mac.local')
  })
})

// ---------------------------------------------------------------------------
// 2. register() rejects invalid URL
// ---------------------------------------------------------------------------

describe('register() — URL validation', () => {
  it('throws for a non-URL string', () => {
    const mgr = createClusterManager({ noPersist: true })
    expect(() => mgr.register(makeRegReq({ url: 'not-a-url' }))).toThrow(/invalid URL/)
  })

  it('throws for ftp:// URL', () => {
    const mgr = createClusterManager({ noPersist: true })
    expect(() => mgr.register(makeRegReq({ url: 'ftp://host/path' }))).toThrow(/http/)
  })

  it('accepts https:// URL', () => {
    const mgr = createClusterManager({ noPersist: true })
    expect(() => mgr.register(makeRegReq({ url: 'https://example.com:8080' }))).not.toThrow()
  })

  it('throws for empty machineId', () => {
    const mgr = createClusterManager({ noPersist: true })
    expect(() => mgr.register(makeRegReq({ machineId: '' }))).toThrow(/machineId/)
  })

  it('throws for empty name', () => {
    const mgr = createClusterManager({ noPersist: true })
    expect(() => mgr.register(makeRegReq({ name: '' }))).toThrow(/name/)
  })
})

// ---------------------------------------------------------------------------
// 3. heartbeat() updates existing machine
// ---------------------------------------------------------------------------

describe('heartbeat()', () => {
  it('updates status, sessionId, project, sessions, and lastSeen', async () => {
    vi.useFakeTimers()
    const mgr = createClusterManager({ noPersist: true })

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

  it('brings offline machine back online with status from heartbeat body', async () => {
    vi.useFakeTimers()
    const mgr = createClusterManager({ noPersist: true, offlineTimeoutMs: 1000, sweepIntervalMs: 500 })

    vi.setSystemTime(0)
    mgr.register(makeRegReq())

    // 触发 sweep，让机器变成 offline
    vi.advanceTimersByTime(1600)
    expect(mgr.getMachine('machine-a')?.status).toBe('offline')

    // 心跳到来，恢复在线
    vi.setSystemTime(2000)
    mgr.heartbeat(makeHbReq({ status: 'idle' }))

    expect(mgr.getMachine('machine-a')?.status).toBe('idle')
    expect(mgr.getMachine('machine-a')?.lastSeen).toBe(2000)

    vi.useRealTimers()
    await mgr.close()
  })

  it('does not modify unrelated fields when optional fields are omitted', () => {
    const mgr = createClusterManager({ noPersist: true })
    mgr.register(makeRegReq())
    mgr.heartbeat(makeHbReq({
      status: 'running',
      sessionId: 'sess-1',
      project: 'proj-a',
    }))

    // Send heartbeat without sessionId/project
    mgr.heartbeat(makeHbReq({ status: 'idle' }))

    const machine = mgr.getMachine('machine-a')!
    // sessionId and project should remain from previous heartbeat
    expect(machine.sessionId).toBe('sess-1')
    expect(machine.project).toBe('proj-a')
    expect(machine.status).toBe('idle')
  })
})

// ---------------------------------------------------------------------------
// 4. heartbeat() for unregistered machineId returns error
// ---------------------------------------------------------------------------

describe('heartbeat() — unregistered machine', () => {
  it('returns { ok: false, error: "not registered" } for unknown machineId', () => {
    const mgr = createClusterManager({ noPersist: true })
    const result = mgr.heartbeat(makeHbReq({ machineId: 'unknown-id' }))
    expect(result).toEqual({ ok: false, error: 'not registered' })
  })
})

// ---------------------------------------------------------------------------
// 5. listMachines() returns sorted by name
// ---------------------------------------------------------------------------

describe('listMachines() — sorting', () => {
  it('returns machines sorted by name ascending', () => {
    const mgr = createClusterManager({ noPersist: true })
    mgr.register(makeRegReq({ machineId: 'id-c', name: 'Charlie' }))
    mgr.register(makeRegReq({ machineId: 'id-a', name: 'Alpha' }))
    mgr.register(makeRegReq({ machineId: 'id-b', name: 'Bravo' }))

    const names = mgr.listMachines().map((m) => m.name)
    expect(names).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })
})

// ---------------------------------------------------------------------------
// 6. listMachines() includes self if configured
// ---------------------------------------------------------------------------

describe('listMachines() — self entry', () => {
  it('includes self entry when configured', () => {
    const mgr = createClusterManager({
      noPersist: true,
      self: {
        machineId: 'server-self',
        name: 'Server',
        url: 'http://server:7860',
        sessionToken: 'server-tok',
      },
    })
    mgr.register(makeRegReq({ machineId: 'client-1', name: 'Client' }))

    const machines = mgr.listMachines()
    const ids = machines.map((m) => m.machineId)
    expect(ids).toContain('server-self')
    expect(ids).toContain('client-1')
  })

  it('self entry status is always idle (never offline)', async () => {
    vi.useFakeTimers()
    const mgr = createClusterManager({
      noPersist: true,
      offlineTimeoutMs: 1000,
      sweepIntervalMs: 500,
      self: {
        machineId: 'server-self',
        name: 'Server',
        url: 'http://server:7860',
        sessionToken: 'tok',
      },
    })

    // Advance well past offline threshold
    vi.advanceTimersByTime(5000)

    const self = mgr.listMachines().find((m) => m.machineId === 'server-self')
    expect(self?.status).toBe('idle')

    vi.useRealTimers()
    await mgr.close()
  })

  it('self entry lastSeen is refreshed on each listMachines() call', () => {
    vi.useFakeTimers()
    const mgr = createClusterManager({
      noPersist: true,
      self: { machineId: 'srv', name: 'Server', url: 'http://srv:7860', sessionToken: 'tok' },
    })

    vi.setSystemTime(1000)
    const first = mgr.listMachines().find((m) => m.machineId === 'srv')!.lastSeen

    vi.setSystemTime(2000)
    const second = mgr.listMachines().find((m) => m.machineId === 'srv')!.lastSeen

    expect(second).toBeGreaterThan(first)

    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// 7. Offline detection: machine marked offline after timeout
// ---------------------------------------------------------------------------

describe('offline detection', () => {
  it('marks machine offline after offlineTimeoutMs passes with no heartbeat', async () => {
    vi.useFakeTimers()
    const mgr = createClusterManager({
      noPersist: true,
      offlineTimeoutMs: 1000,
      sweepIntervalMs: 500,
    })

    vi.setSystemTime(0)
    mgr.register(makeRegReq())
    expect(mgr.getMachine('machine-a')?.status).toBe('idle')

    // 500ms: first sweep — not yet offline (500ms < 1000ms threshold)
    vi.advanceTimersByTime(500)
    expect(mgr.getMachine('machine-a')?.status).toBe('idle')

    // 1000ms: second sweep — exactly at threshold (1000ms >= 1000ms) → offline
    vi.advanceTimersByTime(500)
    expect(mgr.getMachine('machine-a')?.status).toBe('offline')

    vi.useRealTimers()
    await mgr.close()
  })

  it('does not mark machine offline if it keeps sending heartbeats', async () => {
    vi.useFakeTimers()
    const mgr = createClusterManager({
      noPersist: true,
      offlineTimeoutMs: 1000,
      sweepIntervalMs: 500,
    })

    vi.setSystemTime(0)
    mgr.register(makeRegReq())

    // Keep sending heartbeats every 400ms
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

// ---------------------------------------------------------------------------
// 8. Self is never marked offline
// ---------------------------------------------------------------------------

describe('self entry — never offline', () => {
  it('sweep timer never marks self as offline', async () => {
    vi.useFakeTimers()
    const mgr = createClusterManager({
      noPersist: true,
      offlineTimeoutMs: 100,
      sweepIntervalMs: 50,
      self: { machineId: 'srv', name: 'Server', url: 'http://srv', sessionToken: 'tok' },
    })

    // Run many sweeps without updating self lastSeen
    vi.advanceTimersByTime(2000)

    // Self should still not be offline
    const self = mgr.getMachine('srv')
    // 注意：listMachines() 刷新 self 的 lastSeen，getMachine() 直接从 Map 读
    // 但 sweep 不会将 self 标记为 offline
    // 如果 getMachine('srv') 是 undefined 说明 self 只在 listMachines 里注入
    // 通过 listMachines 验证
    const selfViaList = mgr.listMachines().find((m) => m.machineId === 'srv')
    expect(selfViaList?.status).not.toBe('offline')

    vi.useRealTimers()
    await mgr.close()
  })
})

// ---------------------------------------------------------------------------
// 9. Heartbeat arriving for offline machine brings it back online
// ---------------------------------------------------------------------------

describe('heartbeat revives offline machine', () => {
  it('updates status from heartbeat even if machine was offline', async () => {
    vi.useFakeTimers()
    const mgr = createClusterManager({
      noPersist: true,
      offlineTimeoutMs: 1000,
      sweepIntervalMs: 500,
    })

    vi.setSystemTime(0)
    mgr.register(makeRegReq())

    // Let machine go offline
    vi.advanceTimersByTime(1600)
    expect(mgr.getMachine('machine-a')?.status).toBe('offline')

    // Client comes back and sends heartbeat
    vi.setSystemTime(2000)
    const result = mgr.heartbeat(makeHbReq({ status: 'running' }))

    expect(result).toEqual({ ok: true })
    expect(mgr.getMachine('machine-a')?.status).toBe('running')
    expect(mgr.getMachine('machine-a')?.lastSeen).toBe(2000)

    vi.useRealTimers()
    await mgr.close()
  })
})

// ---------------------------------------------------------------------------
// 10. Persistence round-trip: register → close → new manager → state restored
// ---------------------------------------------------------------------------

describe('persistence round-trip', () => {
  const tmpFile = join(tmpdir(), `cluster-test-${process.pid}-${Date.now()}.json`)

  afterEach(async () => {
    // Clean up temp file
    try {
      await unlink(tmpFile)
    } catch {
      // Ignore if file doesn't exist
    }
  })

  it('restores state after close + reload (all entries start as offline)', async () => {
    // Phase 1: register, heartbeat, then close
    const mgr1 = createClusterManager({
      persistPath: tmpFile,
      persistDebounceMs: 0, // write immediately in tests
    })

    mgr1.register(makeRegReq({ machineId: 'mc-1', name: 'Machine One' }))
    mgr1.register(makeRegReq({ machineId: 'mc-2', name: 'Machine Two' }))
    mgr1.heartbeat({ machineId: 'mc-1', status: 'running', project: 'proj-a' })

    await mgr1.close()

    // Verify file was written
    const raw = await readFile(tmpFile, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.version).toBe(1)
    expect(Object.keys(parsed.machines)).toHaveLength(2)

    // Phase 2: create new manager from same file
    // We need to wait a tick for loadPersistedState to run
    const mgr2 = createClusterManager({
      persistPath: tmpFile,
      noPersist: false,
      persistDebounceMs: 100_000, // don't auto-persist during this test
    })

    // Allow async load to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    // All restored machines should be offline initially
    const mc1 = mgr2.getMachine('mc-1')
    const mc2 = mgr2.getMachine('mc-2')

    expect(mc1).toBeDefined()
    expect(mc2).toBeDefined()
    expect(mc1?.status).toBe('offline')
    expect(mc2?.status).toBe('offline')

    // Name and other fields should be preserved
    expect(mc1?.name).toBe('Machine One')
    expect(mc2?.name).toBe('Machine Two')
    expect(mc1?.project).toBe('proj-a')

    await mgr2.close()
  })

  it('does not crash if persist file does not exist', async () => {
    const nonExistentPath = join(tmpdir(), `no-such-file-${Date.now()}.json`)
    // Should not throw
    const mgr = createClusterManager({ persistPath: nonExistentPath })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(mgr.listMachines()).toEqual([])
    await mgr.close()
  })
})
