/**
 * Tests for auth.ts — token generation and verifyClient logic
 *
 * Strategy:
 * - Test generateToken() format and uniqueness
 * - Test createVerifyClient() with correct/incorrect/missing tokens
 * Note: WS integration tests removed (wsServer replaced by sseWriter in T-S05)
 */

import { describe, it, expect } from 'vitest'
import { generateToken, createVerifyClient } from '../src/auth.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests: generateToken
// ---------------------------------------------------------------------------

describe('generateToken', () => {
  it('should return a string starting with rcc_', () => {
    const token = generateToken()
    expect(token.startsWith('rcc_')).toBe(true)
  })

  it('should have the correct length (rcc_ + 43 base64url chars)', () => {
    const token = generateToken()
    // 32 bytes → 43 base64url chars (no padding)
    expect(token.length).toBe(4 + 43)
  })

  it('should only contain valid base64url characters after prefix', () => {
    const token = generateToken()
    const payload = token.slice(4)
    // base64url: A-Z, a-z, 0-9, -, _
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('should generate unique tokens on each call', () => {
    const tokens = new Set<string>()
    for (let i = 0; i < 100; i++) {
      tokens.add(generateToken())
    }
    expect(tokens.size).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// Tests: createVerifyClient
// ---------------------------------------------------------------------------

describe('createVerifyClient', () => {
  const token = 'rcc_test-token-abc123'

  it('should accept a valid Bearer token', () => {
    const verifyClient = createVerifyClient(token)
    const req = { headers: { authorization: `Bearer ${token}` } } as any

    let accepted: boolean | undefined
    let statusCode: number | undefined

    verifyClient({ req }, (result, code) => {
      accepted = result
      statusCode = code
    })

    expect(accepted).toBe(true)
    expect(statusCode).toBeUndefined()
  })

  it('should reject a missing Authorization header', () => {
    const verifyClient = createVerifyClient(token)
    const req = { headers: {} } as any

    let accepted: boolean | undefined
    let statusCode: number | undefined
    let message: string | undefined

    verifyClient({ req }, (result, code, msg) => {
      accepted = result
      statusCode = code
      message = msg
    })

    expect(accepted).toBe(false)
    expect(statusCode).toBe(401)
    expect(message).toBe('Unauthorized')
  })

  it('should reject an incorrect token', () => {
    const verifyClient = createVerifyClient(token)
    const req = { headers: { authorization: 'Bearer wrong-token' } } as any

    let accepted: boolean | undefined
    let statusCode: number | undefined

    verifyClient({ req }, (result, code) => {
      accepted = result
      statusCode = code
    })

    expect(accepted).toBe(false)
    expect(statusCode).toBe(401)
  })

  it('should reject a malformed Authorization header (no Bearer prefix)', () => {
    const verifyClient = createVerifyClient(token)
    const req = { headers: { authorization: token } } as any

    let accepted: boolean | undefined
    let statusCode: number | undefined

    verifyClient({ req }, (result, code) => {
      accepted = result
      statusCode = code
    })

    expect(accepted).toBe(false)
    expect(statusCode).toBe(401)
  })

  it('should reject Basic auth scheme', () => {
    const verifyClient = createVerifyClient(token)
    const req = { headers: { authorization: `Basic ${token}` } } as any

    let accepted: boolean | undefined
    let statusCode: number | undefined

    verifyClient({ req }, (result, code) => {
      accepted = result
      statusCode = code
    })

    expect(accepted).toBe(false)
    expect(statusCode).toBe(401)
  })

  // -------------------------------------------------------------------------
  // Query parameter fallback (browser WebSocket can't set headers)
  // -------------------------------------------------------------------------

  it('should accept a valid token via ?token= query parameter', () => {
    const verifyClient = createVerifyClient(token)
    const req = {
      headers: { host: 'localhost:7860' },
      url: `/?token=${token}`,
    } as any

    let accepted: boolean | undefined
    let statusCode: number | undefined

    verifyClient({ req }, (result, code) => {
      accepted = result
      statusCode = code
    })

    expect(accepted).toBe(true)
    expect(statusCode).toBeUndefined()
  })

  it('should reject a wrong token via query parameter', () => {
    const verifyClient = createVerifyClient(token)
    const req = {
      headers: { host: 'localhost:7860' },
      url: '/?token=wrong-token',
    } as any

    let accepted: boolean | undefined
    let statusCode: number | undefined

    verifyClient({ req }, (result, code) => {
      accepted = result
      statusCode = code
    })

    expect(accepted).toBe(false)
    expect(statusCode).toBe(401)
  })

  it('should prefer Authorization header over query parameter', () => {
    const verifyClient = createVerifyClient(token)
    // Both header and query provided — header is correct
    const req = {
      headers: { authorization: `Bearer ${token}`, host: 'localhost:7860' },
      url: '/?token=wrong-token',
    } as any

    let accepted: boolean | undefined
    verifyClient({ req }, (result) => { accepted = result })
    expect(accepted).toBe(true)
  })

  it('should fall through to query param when header is wrong', () => {
    const verifyClient = createVerifyClient(token)
    const req = {
      headers: { authorization: 'Bearer wrong', host: 'localhost:7860' },
      url: `/?token=${token}`,
    } as any

    let accepted: boolean | undefined
    verifyClient({ req }, (result) => { accepted = result })
    // Header check fails, but query param matches
    expect(accepted).toBe(true)
  })
})

// Note: WS integration tests removed. SSE auth is tested in sseWriter.test.ts (T-S06).
