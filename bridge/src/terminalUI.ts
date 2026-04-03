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

/** Return the first non-internal IPv4 address, or null. */
function detectLocalIP(): string | null {
  try {
    const nets = networkInterfaces()
    for (const ifaces of Object.values(nets)) {
      if (!ifaces) continue
      for (const iface of ifaces) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address
        }
      }
    }
  } catch {
    // Silently ignore — we'll just skip the Network line
  }
  return null
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
 *    Local:     http://localhost:7860
 *    Network:   http://192.168.1.5:7860
 *
 *    Waiting for client connection...
 * ```
 */
export function printStartupBanner(url: string, port: number): void {
  const localIP = detectLocalIP()

  console.log()
  console.log(chalk.bold.cyan(`  remote-cc`) + chalk.dim(` v${VERSION}`))
  console.log()
  console.log(`   ${chalk.dim('Local:')}     ${chalk.green(url)}`)
  if (localIP) {
    console.log(
      `   ${chalk.dim('Network:')}   ${chalk.green(`http://${localIP}:${port}`)}`,
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
