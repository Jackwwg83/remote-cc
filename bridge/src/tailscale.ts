/**
 * tailscale.ts — Detect Tailscale CLI status and IP address.
 *
 * Provides a single function that shells out to the `tailscale` CLI to determine:
 * - Whether Tailscale is installed
 * - Whether the user is logged in / connected
 * - The node's Tailscale IPv4 address (if available)
 *
 * All errors are caught gracefully — a missing binary just returns
 * `{ installed: false, loggedIn: false, ip: null }`.
 */

import { execFile } from 'node:child_process'

export interface TailscaleStatus {
  installed: boolean
  loggedIn: boolean
  ip: string | null
}

/**
 * Run a command and return its stdout trimmed, or null on any failure.
 */
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
 * Detect Tailscale installation status, login state, and IPv4 address.
 *
 * Detection logic:
 * 1. `tailscale ip -4` — if this succeeds with a valid IPv4 address,
 *    Tailscale is installed, logged in, and we have the IP.
 * 2. If `tailscale ip -4` fails, try `tailscale status` to distinguish
 *    "not installed" (ENOENT) from "installed but not logged in".
 */
export async function detectTailscale(): Promise<TailscaleStatus> {
  // Try to get the IPv4 address first — fastest happy path
  const ip = await run('tailscale', ['ip', '-4'])
  if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    return { installed: true, loggedIn: true, ip }
  }

  // ip failed — check if tailscale is at least installed
  const status = await run('tailscale', ['status'])
  if (status !== null) {
    // Command ran (exit 0) but ip failed → installed, not logged in
    return { installed: true, loggedIn: false, ip: null }
  }

  // Both commands failed — not installed (or not in PATH)
  return { installed: false, loggedIn: false, ip: null }
}
