/**
 * Tests for selfUrl.ts — picks the advertised URL for cluster registration.
 */
import { describe, it, expect } from 'vitest'
import { pickSelfUrl } from '../src/selfUrl.js'

const base = {
  port: 7860,
  fallbackHostname: 'my-mac.local',
}

describe('pickSelfUrl', () => {
  it('CLI override wins over every auto-detection', () => {
    const r = pickSelfUrl({
      ...base,
      cliOverride: 'http://custom.example.com:9999',
      envOverride: 'http://env.example.com:8888',
      addrs: { tailscale: '100.64.1.5', lan: '192.168.1.5' },
      tailscale: { installed: true, loggedIn: true, ip: '100.64.1.5' } as unknown as Parameters<typeof pickSelfUrl>[0]['tailscale'],
    })
    expect(r.url).toBe('http://custom.example.com:9999')
    expect(r.source).toBe('cli')
  })

  it('env override wins when no CLI override', () => {
    const r = pickSelfUrl({
      ...base,
      envOverride: 'http://env.example.com:8888',
      addrs: { tailscale: '100.64.1.5', lan: '192.168.1.5' },
    })
    expect(r.url).toBe('http://env.example.com:8888')
    expect(r.source).toBe('env')
  })

  it('tailscale IP beats LAN when both are present', () => {
    const r = pickSelfUrl({
      ...base,
      addrs: { tailscale: '100.64.1.5', lan: '192.168.1.5' },
    })
    expect(r.url).toBe('http://100.64.1.5:7860')
    expect(r.source).toBe('tailscale')
  })

  it('tailscale CLI-reported IP wins over interface-scanned', () => {
    const r = pickSelfUrl({
      ...base,
      addrs: { tailscale: '100.64.1.5', lan: '192.168.1.5' },
      tailscale: { installed: true, loggedIn: true, ip: '100.96.0.4' } as unknown as Parameters<typeof pickSelfUrl>[0]['tailscale'],
    })
    expect(r.url).toBe('http://100.96.0.4:7860')
  })

  it('LAN IP used when no tailscale', () => {
    const r = pickSelfUrl({
      ...base,
      addrs: { tailscale: null, lan: '192.168.1.5' },
    })
    expect(r.url).toBe('http://192.168.1.5:7860')
    expect(r.source).toBe('lan')
  })

  it('hostname fallback when no IPs at all', () => {
    const r = pickSelfUrl({ ...base, addrs: { tailscale: null, lan: null } })
    expect(r.url).toBe('http://my-mac.local:7860')
    expect(r.source).toBe('hostname')
  })

  it('rejects invalid CLI override URL and falls through', () => {
    const r = pickSelfUrl({
      ...base,
      cliOverride: 'not-a-url',
      addrs: { tailscale: null, lan: '192.168.1.5' },
    })
    expect(r.source).toBe('lan')
  })

  it('rejects ftp:// override and falls through', () => {
    const r = pickSelfUrl({
      ...base,
      cliOverride: 'ftp://host/path',
      addrs: { tailscale: null, lan: '10.0.0.5' },
    })
    expect(r.source).toBe('lan')
  })

  it('strips trailing slash from CLI override', () => {
    const r = pickSelfUrl({
      ...base,
      cliOverride: 'http://host:7860/',
      addrs: { tailscale: null, lan: null },
    })
    expect(r.url).toBe('http://host:7860')
  })
})
