/**
 * clusterConfig.ts — Cluster role + identity configuration
 *
 * Parses CLI args / env vars, validates inputs (URL shape, required fields),
 * generates or accepts cluster token. Returned as an immutable object; no
 * module-scoped mutable exports. Consumers call loadClusterConfig() once and
 * pass the result around.
 */

import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { getOrCreateMachineId } from './machineId.js'

export type ClusterRole = 'server' | 'client' | 'standalone'

export interface ClusterConfig {
  role: ClusterRole
  machineId: string
  machineName: string
  /** Server mode: the cluster token (generated or provided). Undefined otherwise. */
  clusterToken?: string
  /** Client mode: the server's URL (validated http(s) URL). Undefined otherwise. */
  serverUrl?: string
  /** Client mode: the cluster token to present to the server. Undefined otherwise. */
  serverToken?: string
}

export interface ClusterArgs {
  role?: string
  server?: string
  'server-token'?: string
  'machine-name'?: string
  'cluster-token'?: string
}

export async function loadClusterConfig(args: ClusterArgs): Promise<ClusterConfig> {
  const roleRaw = args.role ?? process.env.REMOTE_CC_ROLE ?? 'standalone'
  if (!['server', 'client', 'standalone'].includes(roleRaw)) {
    throw new Error(`Invalid role: ${roleRaw}. Must be server, client, or standalone.`)
  }
  const role = roleRaw as ClusterRole

  const machineId = await getOrCreateMachineId()
  const machineName = args['machine-name'] ?? process.env.REMOTE_CC_MACHINE_NAME ?? hostname()

  if (role === 'client') {
    const serverUrlRaw = args.server ?? process.env.REMOTE_CC_SERVER
    const serverToken = args['server-token'] ?? process.env.REMOTE_CC_SERVER_TOKEN
    if (!serverUrlRaw || !serverToken) {
      throw new Error(
        '--role client requires --server <url> and --server-token <token>\n' +
        '(or REMOTE_CC_SERVER + REMOTE_CC_SERVER_TOKEN env vars)',
      )
    }
    // Validate and normalize URL
    let parsed: URL
    try {
      parsed = new URL(serverUrlRaw)
    } catch {
      throw new Error(`Invalid --server URL: ${serverUrlRaw}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`--server must use http:// or https://, got: ${parsed.protocol}`)
    }
    // Normalize: strip trailing slash, keep origin + pathname
    const serverUrl = parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, ''))
    return { role, machineId, machineName, serverUrl, serverToken }
  }

  if (role === 'server') {
    const provided = args['cluster-token'] ?? process.env.REMOTE_CC_CLUSTER_TOKEN
    const clusterToken = provided ?? 'rcc_cluster_' + randomBytes(32).toString('base64url')
    return { role, machineId, machineName, clusterToken }
  }

  // standalone
  return { role, machineId, machineName }
}

/** Redact a token for safe logging: show prefix + length. */
export function maskToken(token: string): string {
  if (token.length < 12) return '***'
  return `${token.slice(0, 12)}…(${token.length} chars)`
}
