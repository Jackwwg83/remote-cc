/**
 * Terminal UI — startup banner, connection status, local IP detection
 *
 * QR code display is deferred to T-31.
 */

import chalk from 'chalk'
import { networkInterfaces } from 'node:os'

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
// Public API
// ---------------------------------------------------------------------------

/**
 * Print the startup banner.
 *
 * ```
 * remote-cc v0.1.0
 *
 *    Local:      http://localhost:7860
 *    Tailscale:  http://100.64.1.5:7860
 *    LAN:        http://192.168.1.5:7860
 *
 *    Waiting for client connection...
 * ```
 */
export function printStartupBanner(url: string, port: number): void {
  const addrs = detectNetworkAddresses()

  console.log()
  console.log(chalk.bold.cyan(`  remote-cc`) + chalk.dim(` v${VERSION}`))
  console.log()
  console.log(`   ${chalk.dim('Local:')}      ${chalk.green(`http://localhost:${port}`)}`)
  if (addrs.tailscale) {
    console.log(
      `   ${chalk.dim('Tailscale:')}  ${chalk.green(`http://${addrs.tailscale}:${port}`)}`,
    )
  }
  if (addrs.lan) {
    console.log(
      `   ${chalk.dim('LAN:')}        ${chalk.green(`http://${addrs.lan}:${port}`)}`,
    )
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
