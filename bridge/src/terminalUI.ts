/**
 * Terminal UI — startup banner, connection status, local IP detection, QR code
 */

import chalk from 'chalk'
import { networkInterfaces } from 'node:os'
import QRCode from 'qrcode'
import type { TailscaleStatus } from './tailscale.js'

const VERSION = '0.1.0'

// ---------------------------------------------------------------------------
// Local IP detection
// ---------------------------------------------------------------------------

/** Detected network addresses, separated by type. */
export interface NetworkAddresses {
  tailscale: string | null
  lan: string | null
}

/**
 * Detect non-internal IPv4 addresses, preferring Tailscale.
 *
 * Tailscale interfaces are identified by:
 * - Interface name: `tailscale0` (Linux), `utun*` (macOS)
 * - Address in the Tailscale CGNAT range: 100.64.0.0/10
 *
 * TODO: tests for IPv6/multi-interface scenarios (complex to mock os.networkInterfaces)
 */
export function detectNetworkAddresses(): NetworkAddresses {
  const result: NetworkAddresses = { tailscale: null, lan: null }
  try {
    const nets = networkInterfaces()
    for (const [name, ifaces] of Object.entries(nets)) {
      if (!ifaces) continue
      for (const iface of ifaces) {
        if (iface.family !== 'IPv4' || iface.internal) continue

        const isTailscaleIface = name === 'tailscale0' || name.startsWith('utun')
        const isTailscaleAddr = iface.address.startsWith('100.')
        // Tailscale CGNAT range: 100.64.0.0 – 100.127.255.255
        const octet2 = parseInt(iface.address.split('.')[1], 10)
        const inCGNAT = isTailscaleAddr && octet2 >= 64 && octet2 <= 127

        if ((isTailscaleIface && isTailscaleAddr) || inCGNAT) {
          if (!result.tailscale) result.tailscale = iface.address
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
 * Print the startup banner with URLs, Tailscale status, and QR code.
 *
 * ```
 * remote-cc v0.1.0
 *
 *    Local:      http://localhost:7860?token=...
 *    Tailscale:  http://100.64.1.5:7860?token=...
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
  tailscale?: TailscaleStatus,
  clusterToken?: string,
): Promise<void> {
  const addrs = detectNetworkAddresses()
  const params = new URLSearchParams()
  if (token) params.set('token', token)
  if (clusterToken) params.set('cluster_token', clusterToken)
  const qs = params.toString() ? `?${params.toString()}` : ''

  // Prefer Tailscale CLI IP over network-interface detection
  const tailscaleIp = tailscale?.ip ?? addrs.tailscale

  console.log()
  console.log(chalk.bold.cyan(`  remote-cc`) + chalk.dim(` v${VERSION}`))
  console.log()
  console.log(`   ${chalk.dim('Local:')}      ${chalk.green(`http://localhost:${port}${qs}`)}`)
  if (tailscaleIp) {
    console.log(
      `   ${chalk.dim('Tailscale:')}  ${chalk.green(`http://${tailscaleIp}:${port}${qs}`)}`,
    )
  }
  if (addrs.lan) {
    console.log(
      `   ${chalk.dim('LAN:')}        ${chalk.green(`http://${addrs.lan}:${port}${qs}`)}`,
    )
  }

  // Tailscale guidance messages
  if (tailscale && !tailscale.installed) {
    console.log()
    console.log(
      `   ${chalk.yellow('Tailscale not found.')} Install: ${chalk.underline('https://tailscale.com/download')}`,
    )
  } else if (tailscale && tailscale.installed && !tailscale.loggedIn) {
    console.log()
    console.log(
      `   ${chalk.yellow('Tailscale installed but not connected.')} Run: ${chalk.cyan('tailscale up')}`,
    )
  }

  if (token) {
    console.log()
    console.log(`   ${chalk.dim('Token:')}      ${chalk.yellow(token)}`)
  }

  // QR codes — show one per available network (LAN + Tailscale)
  const qrUrls: { label: string; url: string }[] = []
  if (addrs.lan) {
    qrUrls.push({ label: 'LAN', url: `http://${addrs.lan}:${port}${qs}` })
  }
  if (tailscaleIp) {
    qrUrls.push({ label: 'Tailscale', url: `http://${tailscaleIp}:${port}${qs}` })
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
