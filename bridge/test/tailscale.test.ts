/**
 * Tests for tailscale.ts — Tailscale CLI detection
 *
 * Strategy:
 * - Mock child_process.execFile to simulate various tailscale CLI outcomes
 * - Test all three states: not installed, installed but not logged in, fully connected
 * - Test edge cases: timeout, malformed output
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock child_process.execFile before importing the module
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

import { execFile } from 'node:child_process'
import { detectTailscale } from '../src/tailscale.js'

const mockExecFile = vi.mocked(execFile)

// Helper to set up execFile mock behavior based on command + args
function mockCommand(
  responses: Record<string, { stdout?: string; error?: Error }>,
) {
  mockExecFile.mockImplementation(((
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string) => void,
  ) => {
    const key = `${cmd} ${args.join(' ')}`
    const response = responses[key]
    if (response?.error) {
      cb(response.error, '')
    } else {
      cb(null, response?.stdout ?? '')
    }
  }) as typeof execFile)
}

describe('detectTailscale', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('should detect installed + logged in with valid IPv4', async () => {
    mockCommand({
      'tailscale ip -4': { stdout: '100.100.1.42\n' },
    })

    const result = await detectTailscale()

    expect(result).toEqual({
      installed: true,
      loggedIn: true,
      ip: '100.100.1.42',
    })
  })

  it('should detect installed but not logged in', async () => {
    const exitError = new Error('not logged in') as Error & { code?: number }
    exitError.code = 1
    mockCommand({
      'tailscale ip -4': { error: exitError },
      'tailscale status': { stdout: 'Logged out.\n' },
    })

    const result = await detectTailscale()

    expect(result).toEqual({
      installed: true,
      loggedIn: false,
      ip: null,
    })
  })

  it('should detect not installed (ENOENT)', async () => {
    const enoent = new Error('spawn tailscale ENOENT') as Error & { code?: string }
    enoent.code = 'ENOENT'
    mockCommand({
      'tailscale ip -4': { error: enoent },
      'tailscale status': { error: enoent },
    })

    const result = await detectTailscale()

    expect(result).toEqual({
      installed: false,
      loggedIn: false,
      ip: null,
    })
  })

  it('should handle malformed IP output gracefully', async () => {
    mockCommand({
      'tailscale ip -4': { stdout: 'some-garbage-output\n' },
      'tailscale status': { stdout: 'connected\n' },
    })

    const result = await detectTailscale()

    // IP doesn't match IPv4 regex, so falls through to status check
    expect(result).toEqual({
      installed: true,
      loggedIn: false,
      ip: null,
    })
  })

  it('should trim whitespace from IP output', async () => {
    mockCommand({
      'tailscale ip -4': { stdout: '  100.64.5.10  \n' },
    })

    const result = await detectTailscale()

    expect(result).toEqual({
      installed: true,
      loggedIn: true,
      ip: '100.64.5.10',
    })
  })
})
