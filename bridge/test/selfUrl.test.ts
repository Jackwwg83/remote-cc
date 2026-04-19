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

describe('pickSelfUrl', () => {
  it('CLI override wins over every auto-detection', () => {
    const r = pickSelfUrl({
      ...base,
      cliOverride: 'http://custom.example.com:9999',
      envOverride: 'http://env.example.com:8888',
      addrs: { mesh: '100.64.1.5', lan: '192.168.1.5' },
      mesh: { kind: 'warp', installed: true, loggedIn: true, ip: '100.64.1.5' } as unknown as MeshArg,
    })
    expect(r.url).toBe('http://custom.example.com:9999')
    expect(r.source).toBe('cli')
  })

  it('env override wins when no CLI override', () => {
    const r = pickSelfUrl({
      ...base,
      envOverride: 'http://env.example.com:8888',
      addrs: { mesh: '100.64.1.5', lan: '192.168.1.5' },
    })
    expect(r.url).toBe('http://env.example.com:8888')
    expect(r.source).toBe('env')
  })

  it('mesh IP beats LAN when both are present', () => {
    const r = pickSelfUrl({
      ...base,
      addrs: { mesh: '100.64.1.5', lan: '192.168.1.5' },
    })
    expect(r.url).toBe('http://100.64.1.5:7860')
    expect(r.source).toBe('mesh')
  })

  it('mesh CLI-reported IP wins over interface-scanned', () => {
    const r = pickSelfUrl({
      ...base,
      addrs: { mesh: '100.64.1.5', lan: '192.168.1.5' },
      mesh: { kind: 'warp', installed: true, loggedIn: true, ip: '100.96.0.4' } as unknown as MeshArg,
    })
    expect(r.url).toBe('http://100.96.0.4:7860')
  })

  it('skips stale mesh interface IP when mesh CLI reports not connected', () => {
    // Scenario: utun interface still has a 100.x address from a previous
    // session, but `warp-cli status` (or `tailscale status`) reports
    // loggedIn=false. The interface IP won't route — fall through to LAN.
    const r = pickSelfUrl({
      ...base,
      addrs: { mesh: '100.64.1.5', lan: '192.168.1.5' },
      mesh: { kind: 'warp', installed: true, loggedIn: false, ip: null } as unknown as MeshArg,
    })
    expect(r.url).toBe('http://192.168.1.5:7860')
    expect(r.source).toBe('lan')
  })

  it('LAN IP used when no mesh', () => {
    const r = pickSelfUrl({
      ...base,
      addrs: { mesh: null, lan: '192.168.1.5' },
    })
    expect(r.url).toBe('http://192.168.1.5:7860')
    expect(r.source).toBe('lan')
  })

  it('hostname fallback when no IPs at all', () => {
    const r = pickSelfUrl({ ...base, addrs: { mesh: null, lan: null } })
    expect(r.url).toBe('http://my-mac.local:7860')
    expect(r.source).toBe('hostname')
  })

  it('rejects invalid CLI override URL and falls through', () => {
    const r = pickSelfUrl({
      ...base,
      cliOverride: 'not-a-url',
      addrs: { mesh: null, lan: '192.168.1.5' },
    })
    expect(r.source).toBe('lan')
  })

  it('rejects ftp:// override and falls through', () => {
    const r = pickSelfUrl({
      ...base,
      cliOverride: 'ftp://host/path',
      addrs: { mesh: null, lan: '10.0.0.5' },
    })
    expect(r.source).toBe('lan')
  })

  it('strips trailing slash from CLI override', () => {
    const r = pickSelfUrl({
      ...base,
      cliOverride: 'http://host:7860/',
      addrs: { mesh: null, lan: null },
    })
    expect(r.url).toBe('http://host:7860')
  })
})
