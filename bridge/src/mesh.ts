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
 * Probe status of a mesh client via CLI, WITHOUT attempting to attribute
 * an IP to a specific client. On a host with multiple utun interfaces
 * (WARP + Tailscale both running, or WARP connected while a stale
 * Tailscale tunnel IP is still bound), matching an IP to one client
 * purely from `ifconfig` output is ambiguous — the first 100.x address
 * we find may not belong to the client we're reporting.
 *
 * We therefore keep CLI detection strict about reachability / kind and
 * leave IP resolution to the unified interface scan in
 * `detectNetworkAddresses()`, which pickSelfUrl() falls back to via
 * `opts.mesh?.ip ?? opts.addrs.mesh`. That avoids the "kind says warp
 * but IP is Tailscale's" mismatch entirely.
 */
async function detectWarp(): Promise<MeshStatus | null> {
  const status = await run(WARP_BIN, ['status'])
  if (status === null) return null // binary not installed
  const loggedIn = warpLoggedInFromStatus(status)
  // IP intentionally null — see module comment above; caller picks up
  // the CGNAT address from detectNetworkAddresses() instead.
  return { installed: true, loggedIn, ip: null, kind: 'warp' }
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

/**
 * Detect which mesh client is *actually providing* the overlay.
 *
 * Probing order (HEALTHY client wins, not just "installed"):
 *   1. If WARP is connected → use WARP.
 *   2. Else if Tailscale is connected → use Tailscale.
 *   3. Else if WARP or Tailscale is installed-but-disconnected → report
 *      whichever we detected (so the banner can show a useful "run X
 *      connect" hint). Prefer Tailscale's detection if both exist since
 *      it comes with richer CLI output.
 *   4. Else → kind='unknown', nothing installed.
 *
 * Without step 2 after a disconnected WARP, a mixed-install machine
 * running Tailscale as its actual overlay would advertise LAN/hostname
 * instead of the reachable 100.x — breaking the "Tailscale fallback for
 * mixed fleets" contract.
 */
export async function detectMesh(): Promise<MeshStatus> {
  const warp = await detectWarp()
  if (warp && warp.loggedIn) return warp

  const ts = await detectTailscaleFallback()
  if (ts && ts.loggedIn) return ts

  // No healthy client — return whichever we could detect, prefer the one
  // with richer status (tailscale fallback with ip? warp with kind info?).
  if (ts) return ts
  if (warp) return warp
  return { installed: false, loggedIn: false, ip: null, kind: 'unknown' }
}
