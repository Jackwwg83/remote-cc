/**
 * Tests for mesh.ts — mesh-network CLI detection (Cloudflare WARP / Tailscale)
 *
 * Probes `warp-cli status` first, falls back to `tailscale status` on mixed
 * fleets. Mocks child_process.execFile to simulate all outcomes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

import { execFile } from 'node:child_process'
import { detectMesh } from '../src/mesh.js'

const mockExecFile = vi.mocked(execFile)

function mockCommand(responses: Record<string, { stdout?: string; error?: Error }>) {
  mockExecFile.mockImplementation(((
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string) => void,
  ) => {
    const key = `${cmd} ${args.join(' ')}`.trim()
    const response = responses[key]
    if (response?.error) {
      cb(response.error, '')
    } else {
      cb(null, response?.stdout ?? '')
    }
  }) as typeof execFile)
}

describe('detectMesh — warp-cli path (current default)', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('detects WARP connected (IP comes from interface scan, not warp-cli)', async () => {
    mockCommand({
      'warp-cli status': { stdout: 'Status update: Connected\nNetwork: healthy\n' },
      // tailscale probes should NOT be reached when warp is healthy
      'tailscale ip -4': { stdout: '100.64.9.9\n' },
    })
    const r = await detectMesh()
    expect(r).toMatchObject({
      kind: 'warp',
      installed: true,
      loggedIn: true,
      // IP intentionally null — avoids mis-attributing an arbitrary
      // CGNAT iface to WARP on hosts with multiple mesh clients.
      ip: null,
    })
  })

  it('reports WARP disconnected WITH tailscale fallback when tailscale is healthy', async () => {
    // Mixed install: WARP present-but-off, Tailscale is the real overlay.
    // detectMesh must prefer the HEALTHY client, not just the first one
    // whose CLI is installed.
    mockCommand({
      'warp-cli status': { stdout: 'Status update: Disconnected\n' },
      'tailscale ip -4': { stdout: '100.64.1.42\n' },
    })
    const r = await detectMesh()
    expect(r).toMatchObject({ kind: 'tailscale', installed: true, loggedIn: true, ip: '100.64.1.42' })
  })

  it('reports WARP disconnected when tailscale also unhealthy', async () => {
    const enoent = new Error('ENOENT') as Error & { code?: string }
    enoent.code = 'ENOENT'
    mockCommand({
      'warp-cli status': { stdout: 'Status update: Disconnected\n' },
      'tailscale ip -4': { error: enoent },
      'tailscale status': { error: enoent },
    })
    const r = await detectMesh()
    // WARP is what we have, even though it's disconnected — so the
    // banner can tell the user to run `warp-cli connect`.
    expect(r).toMatchObject({ kind: 'warp', installed: true, loggedIn: false, ip: null })
  })

  it('treats WARP "Connecting" as not-yet-connected, tries tailscale', async () => {
    const enoent = new Error('ENOENT') as Error & { code?: string }
    enoent.code = 'ENOENT'
    mockCommand({
      'warp-cli status': { stdout: 'Status update: Connecting\n' },
      'tailscale ip -4': { error: enoent },
      'tailscale status': { error: enoent },
    })
    const r = await detectMesh()
    expect(r.loggedIn).toBe(false)
  })
})

describe('detectMesh — Tailscale fallback (legacy mixed fleets)', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('falls through to Tailscale when WARP is not installed', async () => {
    const enoent = new Error('spawn warp-cli ENOENT') as Error & { code?: string }
    enoent.code = 'ENOENT'
    mockCommand({
      'warp-cli status': { error: enoent },
      'tailscale ip -4': { stdout: '100.64.1.42\n' },
    })
    const r = await detectMesh()
    expect(r).toMatchObject({ kind: 'tailscale', installed: true, loggedIn: true, ip: '100.64.1.42' })
  })

  it('falls through to Tailscale, detects installed-but-not-logged-in', async () => {
    const enoent = new Error('ENOENT') as Error & { code?: string }
    enoent.code = 'ENOENT'
    const exitErr = new Error('not logged in') as Error & { code?: number }
    exitErr.code = 1
    mockCommand({
      'warp-cli status': { error: enoent },
      'tailscale ip -4': { error: exitErr },
      'tailscale status': { stdout: 'Logged out.\n' },
    })
    const r = await detectMesh()
    expect(r).toMatchObject({ kind: 'tailscale', installed: true, loggedIn: false, ip: null })
  })
})

describe('detectMesh — neither installed', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns kind=unknown when both CLIs are missing', async () => {
    const enoent = new Error('ENOENT') as Error & { code?: string }
    enoent.code = 'ENOENT'
    mockCommand({
      'warp-cli status': { error: enoent },
      'tailscale ip -4': { error: enoent },
      'tailscale status': { error: enoent },
    })
    const r = await detectMesh()
    expect(r).toEqual({ kind: 'unknown', installed: false, loggedIn: false, ip: null })
  })
})
