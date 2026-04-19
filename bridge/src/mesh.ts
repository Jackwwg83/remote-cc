/**
 * mesh.ts — Detect mesh-network CLI status and IPv4 address.
 *
 * remote-cc was originally built around Tailscale; we've since moved the
 * cluster fabric to Cloudflare WARP (Zero Trust / Warp Connector).
 * Cloudflare WARP and Tailscale both carve private addresses out of the
 * 100.64.0.0/10 CGNAT range, so the interface-side detection in
 * terminalUI.ts works for either. This module handles the CLI-side
 * detection: whether the client binary is installed and whether the
 * daemon is actually connected.
 *
 * Probes, in order:
 *   1. `warp-cli status`         (Cloudflare WARP — current default)
 *   2. `tailscale status`        (legacy fallback for mixed fleets)
 *
 * A missing binary just returns `{ installed: false, loggedIn: false,
 * ip: null }`; never throws.
 */

import { execFile } from 'node:child_process'

/** Which mesh client was detected (if any). */
export type MeshKind = 'warp' | 'tailscale' | 'unknown'

export interface MeshStatus {
  installed: boolean
  /** True when the daemon is connected to the mesh. */
  loggedIn: boolean
  ip: string | null
  kind: MeshKind
}

/** Run a command, return trimmed stdout or null on any failure. */
function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5_000 }, (err, stdout) => {
      if (err) {
        resolve(null)
        return
      }
      resolve(stdout.trim())
    })
  })
}

/**
 * WARP on macOS typically lives in
 * `/Applications/Cloudflare WARP.app/Contents/Resources/warp-cli`, and
 * `/usr/local/bin/warp-cli` is a symlink the installer adds. `execFile`
 * hits the symlink; this helper just names it explicitly for clarity.
 */
const WARP_BIN = 'warp-cli'
const TAILSCALE_BIN = 'tailscale'

/**
 * Parse `warp-cli status` stdout. Typical outputs:
 *   "Status update: Connected\nNetwork: healthy"
 *   "Status update: Disconnected"
 *   "Status update: Connecting"
 */
function warpLoggedInFromStatus(status: string): boolean {
  // Only "Connected" counts as loggedIn; Connecting/Disconnected/Unset don't.
  return /^Status update:\s*Connected\b/im.test(status)
}

/**
 * Pull the mesh IPv4 address from `ifconfig`-style input. Exposed for
 * tests; production callers generally use NetworkAddresses.mesh from
 * terminalUI's interface scan instead, since warp-cli doesn't expose a
 * one-liner for "my WARP IP" on all versions.
 */
export function extractCgnatIpFromIfconfig(ifconfigOut: string): string | null {
  // 100.64.0.0/10 — CGNAT; used by both WARP and Tailscale
  const re = /^\s*inet\s+(100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)\b/m
  const m = ifconfigOut.match(re)
  return m ? m[1] : null
}

async function detectWarp(): Promise<MeshStatus | null> {
  const status = await run(WARP_BIN, ['status'])
  if (status === null) return null // binary not installed
  const loggedIn = warpLoggedInFromStatus(status)
  // warp-cli has no stable "my-ip" command across versions; fall back to
  // the interface scan done by terminalUI.detectNetworkAddresses.
  const ifc = loggedIn ? await run('ifconfig', []) : null
  const ip = ifc ? extractCgnatIpFromIfconfig(ifc) : null
  return { installed: true, loggedIn, ip, kind: 'warp' }
}

async function detectTailscaleFallback(): Promise<MeshStatus | null> {
  const ip = await run(TAILSCALE_BIN, ['ip', '-4'])
  if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    return { installed: true, loggedIn: true, ip, kind: 'tailscale' }
  }
  const status = await run(TAILSCALE_BIN, ['status'])
  if (status !== null) {
    return { installed: true, loggedIn: false, ip: null, kind: 'tailscale' }
  }
  return null
}

export async function detectMesh(): Promise<MeshStatus> {
  const warp = await detectWarp()
  if (warp) return warp
  const ts = await detectTailscaleFallback()
  if (ts) return ts
  return { installed: false, loggedIn: false, ip: null, kind: 'unknown' }
}
