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
 *   2. Tailscale IP (reachable from any peer on the tailnet)
 *   3. Detected LAN IP
 *   4. os.hostname() + port  (fallback; may still work on mDNS/MagicDNS)
 *
 * The caller passes in the already-detected NetworkAddresses + Tailscale
 * status + port so this module stays pure / testable.
 */

import type { NetworkAddresses } from './terminalUI.js'
import type { TailscaleStatus } from './tailscale.js'

export interface PickSelfUrlOpts {
  /** Port the bridge is listening on. */
  port: number
  /** From detectNetworkAddresses(). */
  addrs: NetworkAddresses
  /** From detectTailscale() — may be undefined if detection was skipped. */
  tailscale?: TailscaleStatus
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
  source: 'cli' | 'env' | 'tailscale' | 'lan' | 'hostname'
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

  // 3. Tailscale — prefer the CLI-reported IP, fall back to interface scan.
  // BUT: if the Tailscale CLI explicitly reports the daemon is NOT logged
  // in, an interface-scanned 100.x address is a stale leftover and won't
  // route. Skip the Tailscale branch entirely in that case.
  const tsInstalledButOffline =
    opts.tailscale?.installed === true && opts.tailscale.loggedIn === false
  const tailscaleIp = tsInstalledButOffline
    ? null
    : opts.tailscale?.ip ?? opts.addrs.tailscale
  if (tailscaleIp) {
    return { url: `http://${tailscaleIp}:${opts.port}`, source: 'tailscale' }
  }

  // 4. LAN
  if (opts.addrs.lan) {
    return { url: `http://${opts.addrs.lan}:${opts.port}`, source: 'lan' }
  }

  // 5. Hostname fallback
  return { url: `http://${opts.fallbackHostname}:${opts.port}`, source: 'hostname' }
}
