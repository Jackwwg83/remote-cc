/**
 * Tests for terminalUI.ts — pure helpers only (banner printing + QR
 * generation are side-effectful and not unit-tested here).
 *
 * The ambiguity/offline/CLI-IP resolution lives in resolveBannerMeshIp()
 * to keep the banner in sync with pickSelfUrl — regressions in either
 * could silently advertise a wrong mesh IP.
 */

import { describe, it, expect } from 'vitest'
import { resolveBannerMeshIp } from '../src/terminalUI.js'
import type { MeshStatus } from '../src/mesh.js'
import type { MeshCandidate } from '../src/terminalUI.js'

const warpOn: MeshStatus = { kind: 'warp', installed: true, loggedIn: true, ip: null }
const warpOff: MeshStatus = { kind: 'warp', installed: true, loggedIn: false, ip: null }
const tsOn: MeshStatus = { kind: 'tailscale', installed: true, loggedIn: true, ip: '100.64.1.42' }

const oneCand: MeshCandidate[] = [{ iface: 'utun6', addr: '100.96.0.4' }]
const twoCand: MeshCandidate[] = [
  { iface: 'utun6', addr: '100.96.0.4' },
  { iface: 'utun8', addr: '100.64.1.42' },
]

describe('resolveBannerMeshIp', () => {
  it('returns ip=null ambiguous=false when there is no mesh info', () => {
    expect(resolveBannerMeshIp(undefined, [])).toEqual({ ip: null, ambiguous: false })
  })

  it('returns single candidate when WARP is connected with one CGNAT interface', () => {
    expect(resolveBannerMeshIp(warpOn, oneCand)).toEqual({ ip: '100.96.0.4', ambiguous: false })
  })

  it('reports ambiguous when WARP connected + 2+ CGNAT interfaces + no CLI IP', () => {
    // Classic WARP+Tailscale dual-connect scenario. Banner must NOT show
    // a mesh URL; operator has to set --self-url.
    const r = resolveBannerMeshIp(warpOn, twoCand)
    expect(r).toEqual({ ip: null, ambiguous: true })
  })

  it('trusts CLI self-reported IP even when multiple CGNAT interfaces exist', () => {
    // tailscale ip -4 is authoritative — bypass the ambiguity guard.
    const r = resolveBannerMeshIp(tsOn, twoCand)
    expect(r).toEqual({ ip: '100.64.1.42', ambiguous: false })
  })

  it('SUPPRESSES mesh IP when client installed-but-offline (stale CGNAT leftover)', () => {
    // Regression from the 4th adversarial round: banner used to show
    // the stale utun 100.x from a previous session. Now it should be
    // suppressed entirely — no URL, no QR, no ambiguity warning.
    const r = resolveBannerMeshIp(warpOff, oneCand)
    expect(r).toEqual({ ip: null, ambiguous: false })
  })

  it('offline short-circuit overrides multi-candidate ambiguity too', () => {
    // Even with 2+ stale interfaces, if the CLI says offline we
    // suppress entirely instead of emitting an ambiguity warning.
    const r = resolveBannerMeshIp(warpOff, twoCand)
    expect(r).toEqual({ ip: null, ambiguous: false })
  })

  it('still works when mesh is undefined but interface has one CGNAT IP', () => {
    // No CLI detected at all (no warp, no tailscale), but host has a
    // CGNAT address from some other overlay. Use it.
    expect(resolveBannerMeshIp(undefined, oneCand)).toEqual({ ip: '100.96.0.4', ambiguous: false })
  })
})
