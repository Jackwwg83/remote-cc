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
// WebSocket verifyClient
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
 * Create a `verifyClient` function that checks the Authorization header
 * against the provided token.
 *
 * Accepts: `Authorization: Bearer <token>`
 * Rejects: missing header, wrong format, wrong token → HTTP 401
 */
export function createVerifyClient(
  token: string,
): (info: VerifyClientInfo, cb: VerifyClientCallback) => void {
  return (info: VerifyClientInfo, cb: VerifyClientCallback) => {
    const authHeader = info.req.headers['authorization']
    if (authHeader === `Bearer ${token}`) {
      cb(true)
    } else {
      cb(false, 401, 'Unauthorized')
    }
  }
}
