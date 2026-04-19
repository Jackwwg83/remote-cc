/**
 * Terminal UI — startup banner, connection status, local IP detection, QR code
 */

import chalk from 'chalk'
import { networkInterfaces } from 'node:os'
import QRCode from 'qrcode'
import type { MeshStatus } from './mesh.js'

const VERSION = '0.1.0'

// ---------------------------------------------------------------------------
// Local IP detection
// ---------------------------------------------------------------------------

/** Detected network addresses, separated by type. */
export interface NetworkAddresses {
  /** Mesh-network IP (Cloudflare WARP, or Tailscale on legacy fleets).
   *  Both use the 100.64.0.0/10 CGNAT range, so we can't tell them apart
   *  from the address alone — detectMesh() probes the CLI to identify
   *  which client is actually running. */
  mesh: string | null
  lan: string | null
}

/**
 * Detect non-internal IPv4 addresses, preferring the mesh overlay address.
 *
 * Mesh interfaces are identified by:
 * - Interface name: `utun*` (macOS — used by both Cloudflare WARP and
 *   Tailscale) or `tailscale0` (Linux, Tailscale-specific)
 * - Address in the 100.64.0.0/10 CGNAT range (shared by both)
 *
 * TODO: tests for IPv6/multi-interface scenarios (complex to mock os.networkInterfaces)
 */
export function detectNetworkAddresses(): NetworkAddresses {
  const result: NetworkAddresses = { mesh: null, lan: null }
  try {
    const nets = networkInterfaces()
    for (const [name, ifaces] of Object.entries(nets)) {
      if (!ifaces) continue
      for (const iface of ifaces) {
        if (iface.family !== 'IPv4' || iface.internal) continue

        const isMeshIface = name === 'tailscale0' || name.startsWith('utun')
        const isMeshAddr = iface.address.startsWith('100.')
        // CGNAT range: 100.64.0.0 – 100.127.255.255 (shared by WARP + Tailscale)
        const octet2 = parseInt(iface.address.split('.')[1], 10)
        const inCGNAT = isMeshAddr && octet2 >= 64 && octet2 <= 127

        if ((isMeshIface && isMeshAddr) || inCGNAT) {
          if (!result.mesh) result.mesh = iface.address
        } else {
          if (!result.lan) result.lan = iface.address
        }
      }
    }
  } catch {
    // Silently ignore — we'll just skip the network lines
  }
  return result
}

// ---------------------------------------------------------------------------
// QR code helper
// ---------------------------------------------------------------------------

/**
 * Generate a small terminal-friendly QR code string for the given URL.
 * Returns null if generation fails (non-fatal).
 */
export async function generateQR(url: string): Promise<string | null> {
  try {
    const qr = await QRCode.toString(url, {
      type: 'terminal',
      small: true,
      errorCorrectionLevel: 'L',
    })
    return qr
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Print the startup banner with URLs, mesh overlay status, and QR code.
 *
 * ```
 * remote-cc v0.1.0
 *
 *    Local:      http://localhost:7860?token=...
 *    Mesh:       http://100.96.0.4:7860?token=...  (Cloudflare WARP / Tailscale)
 *    LAN:        http://192.168.1.5:7860?token=...
 *
 *    [QR code]
 *
 *    Waiting for client connection...
 * ```
 */
export async function printStartupBanner(
  url: string,
  port: number,
  token?: string,
  mesh?: MeshStatus,
  clusterToken?: string,
): Promise<void> {
  const addrs = detectNetworkAddresses()
  const params = new URLSearchParams()
  if (token) params.set('token', token)
  if (clusterToken) params.set('cluster_token', clusterToken)
  const qs = params.toString() ? `?${params.toString()}` : ''

  // Prefer mesh CLI-reported IP over interface scan.
  const meshIp = mesh?.ip ?? addrs.mesh
  const meshLabel = mesh?.kind === 'tailscale' ? 'Tailscale' : 'Mesh'

  console.log()
  console.log(chalk.bold.cyan(`  remote-cc`) + chalk.dim(` v${VERSION}`))
  console.log()
  console.log(`   ${chalk.dim('Local:')}      ${chalk.green(`http://localhost:${port}${qs}`)}`)
  if (meshIp) {
    console.log(
      `   ${chalk.dim(`${meshLabel}:`.padEnd(11))}${chalk.green(`http://${meshIp}:${port}${qs}`)}`,
    )
  }
  if (addrs.lan) {
    console.log(
      `   ${chalk.dim('LAN:')}        ${chalk.green(`http://${addrs.lan}:${port}${qs}`)}`,
    )
  }

  // Mesh guidance messages — shaped to whichever client we detected.
  if (mesh && !mesh.installed) {
    console.log()
    console.log(
      `   ${chalk.yellow('Cloudflare WARP not found.')} Install: ${chalk.underline('https://1.1.1.1/')} (or Tailscale as a fallback)`,
    )
  } else if (mesh && mesh.installed && !mesh.loggedIn) {
    console.log()
    const hint = mesh.kind === 'tailscale' ? 'tailscale up' : 'warp-cli connect'
    const name = mesh.kind === 'tailscale' ? 'Tailscale' : 'Cloudflare WARP'
    console.log(
      `   ${chalk.yellow(`${name} installed but not connected.`)} Run: ${chalk.cyan(hint)}`,
    )
  }

  if (token) {
    console.log()
    console.log(`   ${chalk.dim('Token:')}      ${chalk.yellow(token)}`)
  }

  // QR codes — show one per available network (LAN + Mesh)
  const qrUrls: { label: string; url: string }[] = []
  if (addrs.lan) {
    qrUrls.push({ label: 'LAN', url: `http://${addrs.lan}:${port}${qs}` })
  }
  if (meshIp) {
    qrUrls.push({ label: meshLabel, url: `http://${meshIp}:${port}${qs}` })
  }
  if (qrUrls.length === 0) {
    qrUrls.push({ label: 'Local', url: `http://localhost:${port}${qs}` })
  }

  for (const { label, url } of qrUrls) {
    const qr = await generateQR(url)
    if (qr) {
      console.log()
      console.log(`   ${chalk.dim(`Scan to connect (${label}):`)}`)
      for (const line of qr.split('\n')) {
        if (line) console.log(`   ${line}`)
      }
    }
  }

  console.log()
  console.log(`   ${chalk.yellow('Waiting for client connection...')}`)
  console.log()
}

/** Print a "client connected" status line. */
export function printConnected(clientCount: number): void {
  const label = clientCount === 1 ? 'client' : 'clients'
  console.log(
    chalk.green(`   Connected`) +
      chalk.dim(` — ${clientCount} ${label} active`),
  )
}

/** Print a "client disconnected" status line. */
export function printDisconnected(): void {
  console.log(chalk.yellow(`   Client disconnected`))
}
