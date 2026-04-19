/**
 * selfUrl.ts — Pick the URL we advertise to the rest of the cluster.
 *
 * Registering `http://${os.hostname()}:${port}` with the cluster server
 * only works when the other machines can resolve that hostname. On a
 * typical phone + LAN setup the hostname is unresolvable, so proxy +
 * refresh + migration all fail against "online" machines.
 *
 * Resolution priority (first one that yields a value wins):
 *   1. --self-url CLI flag / REMOTE_CC_SELF_URL env  (operator override)
 *   2. Mesh overlay IP (Cloudflare WARP / Tailscale — reachable from any
 *      peer on the mesh)
 *   3. Detected LAN IP
 *   4. os.hostname() + port  (fallback; may still work on mDNS)
 *
 * The caller passes in the already-detected NetworkAddresses + mesh
 * status + port so this module stays pure / testable.
 */

import type { NetworkAddresses } from './terminalUI.js'
import type { MeshStatus } from './mesh.js'

export interface PickSelfUrlOpts {
  /** Port the bridge is listening on. */
  port: number
  /** From detectNetworkAddresses(). */
  addrs: NetworkAddresses
  /** From detectMesh() — may be undefined if detection was skipped. */
  mesh?: MeshStatus
  /** CLI override: --self-url http://host:port (no path). */
  cliOverride?: string
  /** Env override: REMOTE_CC_SELF_URL. Applied only if cliOverride absent. */
  envOverride?: string
  /** Fallback hostname (usually os.hostname()). */
  fallbackHostname: string
}

export interface PickSelfUrlResult {
  url: string
  /** Which source supplied the URL — useful for startup logging. */
  source: 'cli' | 'env' | 'mesh' | 'lan' | 'hostname'
  /** Non-fatal note the caller should surface to the user at startup.
   *  e.g. "multiple mesh clients detected, advertising LAN to be safe". */
  warning?: string
}

/** Normalize http(s) URL input: strip trailing slash, verify scheme. */
function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''))
  } catch {
    return null
  }
}

export function pickSelfUrl(opts: PickSelfUrlOpts): PickSelfUrlResult {
  // 1. CLI override
  if (opts.cliOverride) {
    const norm = normalizeUrl(opts.cliOverride)
    if (norm) return { url: norm, source: 'cli' }
    // If the operator passed something non-parseable, fall through loudly
    // rather than silently swallowing; callers decide whether to warn.
  }

  // 2. Env override
  if (opts.envOverride) {
    const norm = normalizeUrl(opts.envOverride)
    if (norm) return { url: norm, source: 'env' }
  }

  // 3. Mesh overlay (Cloudflare WARP / Tailscale) — prefer the CLI-reported
  // IP, fall back to interface scan. Several guards:
  //   a. If the mesh CLI explicitly reports NOT connected, a scanned
  //      100.x address is likely a stale leftover and won't route —
  //      skip mesh entirely.
  //   b. If MULTIPLE CGNAT interfaces are up (e.g. both WARP and
  //      Tailscale connected, or stale tunnels), we can't safely attribute
  //      the IP to the "winning" client. Rather than risk advertising
  //      e.g. a Tailscale address while kind='warp' (a WARP-only peer
  //      won't route there), skip mesh and tell the operator to set
  //      --self-url. Only bypass when the CLI gave us an exact IP.
  const meshInstalledButOffline =
    opts.mesh?.installed === true && opts.mesh.loggedIn === false
  const candidates = opts.addrs.meshCandidates ?? []
  const cliIp = opts.mesh?.ip ?? null

  if (!meshInstalledButOffline) {
    if (cliIp) {
      // Trust the CLI's own answer when it gave us one (tailscale ip -4)
      return { url: `http://${cliIp}:${opts.port}`, source: 'mesh' }
    }
    if (candidates.length === 1) {
      return { url: `http://${candidates[0].addr}:${opts.port}`, source: 'mesh' }
    }
    if (candidates.length > 1) {
      // Ambiguous — fall through with a loud warning; operator must set
      // --self-url to resolve. Better to advertise a reachable LAN/hostname
      // than a potentially wrong 100.x.
      const list = candidates.map((c) => `${c.iface}=${c.addr}`).join(', ')
      const warning = `Multiple mesh-overlay interfaces detected (${list}); cannot safely pick one. Set --self-url to override.`
      // Fall through to LAN/hostname; attach warning to whatever wins.
      if (opts.addrs.lan) {
        return { url: `http://${opts.addrs.lan}:${opts.port}`, source: 'lan', warning }
      }
      return { url: `http://${opts.fallbackHostname}:${opts.port}`, source: 'hostname', warning }
    }
    // candidates.length === 0 and no CLI IP → truly no mesh; fall through
  }

  // 4. LAN
  if (opts.addrs.lan) {
    return { url: `http://${opts.addrs.lan}:${opts.port}`, source: 'lan' }
  }

  // 5. Hostname fallback
  return { url: `http://${opts.fallbackHostname}:${opts.port}`, source: 'hostname' }
}
