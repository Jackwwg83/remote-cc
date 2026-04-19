/**
 * Tests for migrator.ts — cold session migration.
 *
 * Mocks spawn + fetch so tests don't touch the real filesystem or network.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { createMigrator, cwdHash } from '../src/migrator.js'
import type { ClusterManager, MachineState } from '../src/clusterManager.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMachine(overrides?: Partial<MachineState>): MachineState {
  return {
    machineId: 'uuid-a',
    name: 'Alpha',
    url: 'http://alpha:7860',
    sessionToken: 'tok-alpha',
    status: 'idle',
    sessions: [],
    lastSeen: Date.now(),
    firstSeen: Date.now(),
    hostname: 'alpha.local',
    ...overrides,
  }
}

function makeCluster(machines: Record<string, MachineState>): ClusterManager {
  return {
    register: vi.fn(),
    heartbeat: vi.fn(),
    listMachines: () => Object.values(machines),
    getMachine: (id: string) => machines[id],
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as ClusterManager
}

/** Fake child_process.spawn that records calls + returns configured exit codes. */
function makeSpawnMock(responses: Array<{ code: number; stderr?: string }>) {
  const calls: Array<{ bin: string; args: string[] }> = []
  let i = 0
  const spawnImpl = vi.fn((bin: string, args: readonly string[]) => {
    calls.push({ bin, args: [...args] })
    const ee = new EventEmitter() as unknown as {
      stderr?: EventEmitter
      on: (e: string, fn: (arg?: unknown) => void) => unknown
      emit: (e: string, arg?: unknown) => boolean
    }
    const stderrEE = new EventEmitter() as unknown as EventEmitter & { on: EventEmitter['on'] }
    ;(ee as unknown as { stderr: EventEmitter }).stderr = stderrEE
    // Resolve on next tick
    const resp = responses[i++] ?? { code: 0 }
    setImmediate(() => {
      if (resp.stderr) stderrEE.emit('data', Buffer.from(resp.stderr))
      ;(ee as unknown as { emit: (e: string, arg?: unknown) => boolean }).emit('exit', resp.code)
    })
    return ee as unknown as ReturnType<typeof import('node:child_process').spawn>
  })
  return { spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn, calls }
}

function makeFetchResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response
}

afterEach(() => { vi.restoreAllMocks() })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cwdHash', () => {
  it('is deterministic + hex', () => {
    const a = cwdHash('/Users/jack/proj')
    const b = cwdHash('/Users/jack/proj')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
  })

  it('differs for different paths', () => {
    expect(cwdHash('/a')).not.toBe(cwdHash('/b'))
  })
})

describe('migrator.migrate()', () => {
  const base = {
    clusterToken: 'clust-tok',
    selfServerUrl: 'http://server:7860',
  }

  it('returns error when source machine is unknown', async () => {
    const cluster = makeCluster({ 'dst': makeMachine({ machineId: 'dst' }) })
    const mig = createMigrator({ cluster, ...base })
    const result = await mig.migrate({ fromMachineId: 'ghost', toMachineId: 'dst', sessionId: 's1' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/unknown source/)
  })

  it('returns error when source is offline', async () => {
    const cluster = makeCluster({
      src: makeMachine({ machineId: 'src', status: 'offline' }),
      dst: makeMachine({ machineId: 'dst' }),
    })
    const mig = createMigrator({ cluster, ...base })
    const r = await mig.migrate({ fromMachineId: 'src', toMachineId: 'dst', sessionId: 's1' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/offline/)
  })

  it('returns error when session not found on source', async () => {
    const cluster = makeCluster({
      src: makeMachine({ machineId: 'src', sessions: [] }),
      dst: makeMachine({ machineId: 'dst' }),
    })
    const mig = createMigrator({ cluster, ...base })
    const r = await mig.migrate({ fromMachineId: 'src', toMachineId: 'dst', sessionId: 'nope' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/session nope not found/)
  })

  it('stops running source session before migrating', async () => {
    const cluster = makeCluster({
      src: makeMachine({
        machineId: 'src',
        status: 'running',
        sessionId: 's1',
        sessions: [{ id: 's1', shortId: 's100', project: 'p', cwd: '/tmp/p', time: '2026-01-01', summary: '' }],
      }),
      dst: makeMachine({ machineId: 'dst' }),
    })
    const { spawnImpl } = makeSpawnMock([
      { code: 0 }, // rsync
      { code: 0 }, // ssh mkdir
      { code: 0 }, // scp
    ])
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeFetchResp({ ok: true })) // stop
      .mockResolvedValueOnce(makeFetchResp({ ok: true })) // start
    const mig = createMigrator({ cluster, spawnImpl, fetchImpl: fetchMock, ...base })
    const r = await mig.migrate({ fromMachineId: 'src', toMachineId: 'dst', sessionId: 's1' })
    expect(r.ok).toBe(true)
    // First call should be the stop action
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(firstBody).toMatchObject({ machineId: 'src', action: 'stop_session' })
  })

  it('happy path: rsync + mkdir + scp + start → ok true', async () => {
    const cluster = makeCluster({
      src: makeMachine({
        machineId: 'src',
        sessions: [{ id: 's1', shortId: 's100', project: 'p', cwd: '/tmp/p', time: '2026-01-01', summary: '' }],
        hostname: 'alpha-host',
      }),
      dst: makeMachine({ machineId: 'dst', hostname: 'bravo-host' }),
    })
    const { spawnImpl, calls } = makeSpawnMock([
      { code: 0 }, // rsync
      { code: 0 }, // ssh mkdir
      { code: 0 }, // scp
    ])
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResp({ ok: true }))
    const mig = createMigrator({ cluster, spawnImpl, fetchImpl: fetchMock, ...base })
    const r = await mig.migrate({ fromMachineId: 'src', toMachineId: 'dst', sessionId: 's1' })
    expect(r.ok).toBe(true)
    // rsync used correct src/dst hostnames
    expect(calls[0].bin).toBe('rsync')
    expect(calls[0].args.some((a) => a.includes('alpha-host:/tmp/p/'))).toBe(true)
    expect(calls[0].args.some((a) => a.includes('bravo-host:/tmp/p/'))).toBe(true)
    // scp used the cwd hash path
    const expected = cwdHash('/tmp/p')
    expect(calls[2].args.some((a) => a.includes(expected))).toBe(true)
  })

  it('scp failure aborts migration with specific error', async () => {
    const cluster = makeCluster({
      src: makeMachine({
        machineId: 'src',
        sessions: [{ id: 's1', shortId: 's100', project: 'p', cwd: '/tmp/p', time: '2026-01-01', summary: '' }],
      }),
      dst: makeMachine({ machineId: 'dst' }),
    })
    const { spawnImpl } = makeSpawnMock([
      { code: 0 },             // rsync
      { code: 0 },             // ssh mkdir
      { code: 1, stderr: 'permission denied' },  // scp
    ])
    const fetchMock = vi.fn()
    const mig = createMigrator({ cluster, spawnImpl, fetchImpl: fetchMock, ...base })
    const r = await mig.migrate({ fromMachineId: 'src', toMachineId: 'dst', sessionId: 's1' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/scp failed/)
    // We never tried to start on the target
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rsync failure is non-fatal (logs warning, continues)', async () => {
    const cluster = makeCluster({
      src: makeMachine({
        machineId: 'src',
        sessions: [{ id: 's1', shortId: 's100', project: 'p', cwd: '/tmp/p', time: '2026-01-01', summary: '' }],
      }),
      dst: makeMachine({ machineId: 'dst' }),
    })
    const { spawnImpl } = makeSpawnMock([
      { code: 23, stderr: 'partial xfer' }, // rsync warning
      { code: 0 },                          // ssh mkdir
      { code: 0 },                          // scp
    ])
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResp({ ok: true }))
    const mig = createMigrator({ cluster, spawnImpl, fetchImpl: fetchMock, ...base })
    const r = await mig.migrate({ fromMachineId: 'src', toMachineId: 'dst', sessionId: 's1' })
    expect(r.ok).toBe(true)
    expect(r.steps.some((s) => s.includes('rsync warning'))).toBe(true)
  })

  it('start-on-target failure returns error', async () => {
    const cluster = makeCluster({
      src: makeMachine({
        machineId: 'src',
        sessions: [{ id: 's1', shortId: 's100', project: 'p', cwd: '/tmp/p', time: '2026-01-01', summary: '' }],
      }),
      dst: makeMachine({ machineId: 'dst' }),
    })
    const { spawnImpl } = makeSpawnMock([{ code: 0 }, { code: 0 }, { code: 0 }])
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResp({ error: 'busy' }, 409))
    const mig = createMigrator({ cluster, spawnImpl, fetchImpl: fetchMock, ...base })
    const r = await mig.migrate({ fromMachineId: 'src', toMachineId: 'dst', sessionId: 's1' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/start on target failed/)
  })
})
