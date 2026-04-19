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
import { detectMesh, extractCgnatIpFromIfconfig } from '../src/mesh.js'

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

describe('extractCgnatIpFromIfconfig', () => {
  it('finds a 100.96.x.x address (Cloudflare WARP typical)', () => {
    const out = `\
utun6: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1380
	inet 100.96.0.4 --> 100.96.0.4 netmask 0xffffffff
`
    expect(extractCgnatIpFromIfconfig(out)).toBe('100.96.0.4')
  })

  it('finds a 100.64.x.x address (Tailscale typical)', () => {
    const out = `\
tailscale0: flags=8063 mtu 1280
	inet 100.64.1.42 --> 100.64.1.42 netmask 0xffffffff
`
    expect(extractCgnatIpFromIfconfig(out)).toBe('100.64.1.42')
  })

  it('ignores non-CGNAT 100.x (e.g. 100.10.x = public)', () => {
    const out = `\
en0: flags=8863
	inet 100.10.1.2 netmask 0xffffff00
`
    expect(extractCgnatIpFromIfconfig(out)).toBeNull()
  })

  it('ignores 100.128.x (past the CGNAT upper bound)', () => {
    const out = `\
en0: flags=8863
	inet 100.128.0.5 netmask 0xffffff00
`
    expect(extractCgnatIpFromIfconfig(out)).toBeNull()
  })

  it('returns null when no matching interface', () => {
    expect(extractCgnatIpFromIfconfig('no addresses here')).toBeNull()
  })
})

describe('detectMesh — warp-cli path (current default)', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('detects WARP connected + extracts CGNAT IP from ifconfig', async () => {
    mockCommand({
      'warp-cli status': { stdout: 'Status update: Connected\nNetwork: healthy\n' },
      ifconfig: {
        stdout: 'utun6: flags=8051\n\tinet 100.96.0.4 --> 100.96.0.4 netmask 0xffffffff\n',
      },
    })
    const r = await detectMesh()
    expect(r).toMatchObject({
      kind: 'warp',
      installed: true,
      loggedIn: true,
      ip: '100.96.0.4',
    })
  })

  it('detects WARP installed but disconnected', async () => {
    mockCommand({
      'warp-cli status': { stdout: 'Status update: Disconnected\n' },
    })
    const r = await detectMesh()
    expect(r).toMatchObject({ kind: 'warp', installed: true, loggedIn: false, ip: null })
  })

  it('treats WARP "Connecting" as not-yet-connected', async () => {
    mockCommand({
      'warp-cli status': { stdout: 'Status update: Connecting\n' },
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
