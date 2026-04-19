/**
 * Tests for selfUrl.ts — picks the advertised URL for cluster registration.
 */
import { describe, it, expect } from 'vitest'
import { pickSelfUrl } from '../src/selfUrl.js'

const base = {
  port: 7860,
  fallbackHostname: 'my-mac.local',
}

type MeshArg = Parameters<typeof pickSelfUrl>[0]['mesh']
type AddrsArg = Parameters<typeof pickSelfUrl>[0]['addrs']

/** Convenience constructor: fill in meshCandidates from the scalar fields
 *  when the test writer only cared about the simpler cases. */
function addrs(overrides: Partial<AddrsArg> = {}): AddrsArg {
  const seed: AddrsArg = { mesh: null, meshCandidates: [], lan: null }
  const merged = { ...seed, ...overrides }
  if (merged.mesh && merged.meshCandidates.length === 0) {
    merged.meshCandidates = [{ iface: 'utun-test', addr: merged.mesh }]
  }
  return merged
}

describe('pickSelfUrl', () => {
  it('CLI override wins over every auto-detection', () => {
    const r = pickSelfUrl({
      ...base,
      cliOverride: 'http://custom.example.com:9999',
      envOverride: 'http://env.example.com:8888',
      addrs: addrs({ mesh: '100.64.1.5', lan: '192.168.1.5' }),
      mesh: { kind: 'warp', installed: true, loggedIn: true, ip: '100.64.1.5' } as unknown as MeshArg,
    })
    expect(r.url).toBe('http://custom.example.com:9999')
    expect(r.source).toBe('cli')
  })

  it('env override wins when no CLI override', () => {
    const r = pickSelfUrl({
      ...base,
      envOverride: 'http://env.example.com:8888',
      addrs: addrs({ mesh: '100.64.1.5', lan: '192.168.1.5' }),
    })
    expect(r.url).toBe('http://env.example.com:8888')
    expect(r.source).toBe('env')
  })

  it('mesh IP beats LAN when both are present', () => {
    const r = pickSelfUrl({
      ...base,
      addrs: addrs({ mesh: '100.64.1.5', lan: '192.168.1.5' }),
    })
    expect(r.url).toBe('http://100.64.1.5:7860')
    expect(r.source).toBe('mesh')
  })

  it('mesh CLI-reported IP wins over interface-scanned', () => {
    const r = pickSelfUrl({
      ...base,
      addrs: addrs({ mesh: '100.64.1.5', lan: '192.168.1.5' }),
      mesh: { kind: 'tailscale', installed: true, loggedIn: true, ip: '100.96.0.4' } as unknown as MeshArg,
    })
    expect(r.url).toBe('http://100.96.0.4:7860')
  })

  it('skips stale mesh interface IP when mesh CLI reports not connected', () => {
    const r = pickSelfUrl({
      ...base,
      addrs: addrs({ mesh: '100.64.1.5', lan: '192.168.1.5' }),
      mesh: { kind: 'warp', installed: true, loggedIn: false, ip: null } as unknown as MeshArg,
    })
    expect(r.url).toBe('http://192.168.1.5:7860')
    expect(r.source).toBe('lan')
  })

  it('LAN IP used when no mesh', () => {
    const r = pickSelfUrl({ ...base, addrs: addrs({ lan: '192.168.1.5' }) })
    expect(r.url).toBe('http://192.168.1.5:7860')
    expect(r.source).toBe('lan')
  })

  it('hostname fallback when no IPs at all', () => {
    const r = pickSelfUrl({ ...base, addrs: addrs() })
    expect(r.url).toBe('http://my-mac.local:7860')
    expect(r.source).toBe('hostname')
  })

  it('rejects invalid CLI override URL and falls through', () => {
    const r = pickSelfUrl({
      ...base,
      cliOverride: 'not-a-url',
      addrs: addrs({ lan: '192.168.1.5' }),
    })
    expect(r.source).toBe('lan')
  })

  it('rejects ftp:// override and falls through', () => {
    const r = pickSelfUrl({
      ...base,
      cliOverride: 'ftp://host/path',
      addrs: addrs({ lan: '10.0.0.5' }),
    })
    expect(r.source).toBe('lan')
  })

  it('strips trailing slash from CLI override', () => {
    const r = pickSelfUrl({
      ...base,
      cliOverride: 'http://host:7860/',
      addrs: addrs(),
    })
    expect(r.url).toBe('http://host:7860')
  })

  // ------------------------------------------------------------------------
  // Multi-CGNAT ambiguity (WARP + Tailscale both connected)
  // ------------------------------------------------------------------------

  it('refuses to pick when multiple CGNAT interfaces exist — falls through to LAN with warning', () => {
    // Both WARP (utun6) and Tailscale (utun8) have 100.x addresses. We
    // can't safely attribute one to the kind reported by detectMesh(),
    // so pickSelfUrl bails out to LAN + warns the operator.
    const r = pickSelfUrl({
      ...base,
      addrs: {
        mesh: '100.96.0.4',
        meshCandidates: [
          { iface: 'utun6', addr: '100.96.0.4' },
          { iface: 'utun8', addr: '100.64.1.42' },
        ],
        lan: '192.168.1.5',
      },
      mesh: { kind: 'warp', installed: true, loggedIn: true, ip: null } as unknown as MeshArg,
    })
    expect(r.source).toBe('lan')
    expect(r.url).toBe('http://192.168.1.5:7860')
    expect(r.warning).toMatch(/multiple mesh/i)
    expect(r.warning).toMatch(/utun6=100\.96\.0\.4/)
    expect(r.warning).toMatch(/utun8=100\.64\.1\.42/)
    expect(r.warning).toMatch(/--self-url/)
  })

  it('ambiguous multi-CGNAT + no LAN → hostname fallback + warning', () => {
    const r = pickSelfUrl({
      ...base,
      addrs: {
        mesh: '100.96.0.4',
        meshCandidates: [
          { iface: 'utun6', addr: '100.96.0.4' },
          { iface: 'utun8', addr: '100.64.1.42' },
        ],
        lan: null,
      },
    })
    expect(r.source).toBe('hostname')
    expect(r.warning).toBeDefined()
  })

  it('CLI-reported IP BYPASSES the ambiguity guard (tailscale ip -4 is authoritative)', () => {
    // If detectMesh ran `tailscale ip -4` and got an answer, trust it
    // even when other CGNAT interfaces exist.
    const r = pickSelfUrl({
      ...base,
      addrs: {
        mesh: '100.96.0.4',
        meshCandidates: [
          { iface: 'utun6', addr: '100.96.0.4' },
          { iface: 'utun8', addr: '100.64.1.42' },
        ],
        lan: '192.168.1.5',
      },
      mesh: { kind: 'tailscale', installed: true, loggedIn: true, ip: '100.64.1.42' } as unknown as MeshArg,
    })
    expect(r.source).toBe('mesh')
    expect(r.url).toBe('http://100.64.1.42:7860')
    expect(r.warning).toBeUndefined()
  })

  it('single CGNAT candidate still used directly (no ambiguity, no warning)', () => {
    const r = pickSelfUrl({
      ...base,
      addrs: {
        mesh: '100.96.0.4',
        meshCandidates: [{ iface: 'utun6', addr: '100.96.0.4' }],
        lan: '192.168.1.5',
      },
      mesh: { kind: 'warp', installed: true, loggedIn: true, ip: null } as unknown as MeshArg,
    })
    expect(r.source).toBe('mesh')
    expect(r.url).toBe('http://100.96.0.4:7860')
    expect(r.warning).toBeUndefined()
  })
})
