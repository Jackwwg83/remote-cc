/**
 * Tests for T-M25 — codex engine arg building.
 *
 * Only tests pure arg construction (no process spawn), so the codex binary
 * does not need to be installed in CI.
 */

import { describe, it, expect } from 'vitest'
import { buildArgs, CODEX_ARGS, SpawnError } from '../src/spawner.js'

describe('codex engine buildArgs', () => {
  it('uses CODEX_ARGS as the base for engine=codex', () => {
    const args = buildArgs({ engine: 'codex' })
    for (const expected of CODEX_ARGS) {
      expect(args).toContain(expected)
    }
  })

  it('does NOT include claude-specific flags for engine=codex', () => {
    const args = buildArgs({ engine: 'codex' })
    expect(args).not.toContain('--input-format')
    expect(args).not.toContain('--include-partial-messages')
  })

  it('throws SpawnError on resume mode for codex (no persistent session)', () => {
    expect(() => buildArgs({ engine: 'codex', mode: 'resume', sessionId: 'abc' }))
      .toThrowError(SpawnError)
  })

  it('throws SpawnError on continue mode for codex', () => {
    expect(() => buildArgs({ engine: 'codex', mode: 'continue' }))
      .toThrowError(SpawnError)
  })

  it('appends extraArgs after codex defaults', () => {
    const args = buildArgs({ engine: 'codex', extraArgs: ['--model', 'gpt-5-codex'] })
    const idx = args.indexOf('--model')
    // extraArgs come after the last CODEX_ARGS entry
    expect(idx).toBeGreaterThan(args.indexOf(CODEX_ARGS[CODEX_ARGS.length - 1]))
    expect(args[idx + 1]).toBe('gpt-5-codex')
  })

  it('default engine is claude (explicit absence of engine field → CLAUDE_ARGS)', () => {
    const args = buildArgs({})
    expect(args).toContain('--input-format')
  })
})
