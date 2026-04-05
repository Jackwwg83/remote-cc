/**
 * auth.ts — Token generation and WebSocket authentication middleware.
 *
 * Provides:
 * - `generateToken()` — creates a random bearer token (`rcc_` + 32 bytes base64url)
 * - `createVerifyClient()` — returns a `verifyClient` function for the ws library
 *   that validates `Authorization: Bearer <token>` on WebSocket upgrade requests
 */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

/**
 * Generate a random authentication token.
 *
 * Format: `rcc_` prefix + 32 random bytes encoded as base64url (no padding).
 * Total length: 4 + 43 = 47 characters.
 */
export function generateToken(): string {
  const bytes = randomBytes(32)
  const encoded = bytes.toString('base64url')
  return `rcc_${encoded}`
}

// ---------------------------------------------------------------------------
// Shared token verification (used by HTTP routes + SSE endpoint)
// ---------------------------------------------------------------------------

/**
 * Check if the request carries a valid auth token.
 * Checks Authorization header first, falls back to ?token= query param.
 * Returns true if token matches or no token is required.
 */
export function verifyToken(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true
  const authHeader = req.headers['authorization']
  if (authHeader === `Bearer ${token}`) return true
  try {
    const url = new URL(req.url ?? '', `http://${req.headers.host}`)
    const queryToken = url.searchParams.get('token')
    if (queryToken === token) return true
  } catch { /* malformed URL */ }
  return false
}

// ---------------------------------------------------------------------------
// WebSocket verifyClient (legacy — kept for reference, unused after SSE migration)
// ---------------------------------------------------------------------------

/**
 * Info object passed to the ws `verifyClient` callback.
 * Matches the ws library's VerifyClientCallbackAsync signature.
 */
export interface VerifyClientInfo {
  req: IncomingMessage
}

/** Callback signature used by the ws library for async client verification. */
export type VerifyClientCallback = (
  result: boolean,
  code?: number,
  message?: string,
) => void

/**
 * Create a `verifyClient` function that checks the token via:
 *   1. `Authorization: Bearer <token>` header (preferred, for CLI/native clients)
 *   2. `?token=<token>` query parameter (fallback, for browser WebSocket which
 *      cannot set custom headers on `new WebSocket(url)`)
 *
 * Rejects: missing/wrong token → HTTP 401
 */
export function createVerifyClient(
  token: string,
): (info: VerifyClientInfo, cb: VerifyClientCallback) => void {
  return (info: VerifyClientInfo, cb: VerifyClientCallback) => {
    // 1. Check Authorization header first
    const authHeader = info.req.headers['authorization']
    if (authHeader === `Bearer ${token}`) {
      cb(true)
      return
    }

    // 2. Fallback: check ?token= query parameter
    try {
      const url = new URL(info.req.url ?? '', `http://${info.req.headers.host}`)
      const queryToken = url.searchParams.get('token')
      if (queryToken === token) {
        cb(true)
        return
      }
    } catch {
      // Malformed URL — fall through to reject
    }

    cb(false, 401, 'Unauthorized')
  }
}
