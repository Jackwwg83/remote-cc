/**
 * Tests for spawner.ts — resume/continue mode and buildArgs helper.
 *
 * These tests exercise the args-generation logic without spawning any real
 * processes. All assertions operate on the output of buildArgs() directly.
 */

import { describe, it, expect } from 'vitest'
import { buildArgs, SpawnError, CLAUDE_ARGS } from '../src/spawner.js'

describe('buildArgs — default / new mode', () => {
  it('returns CLAUDE_ARGS when no opts provided', () => {
    const args = buildArgs()
    expect(args).toEqual([...CLAUDE_ARGS])
  })

  it('returns CLAUDE_ARGS when mode is "new"', () => {
    const args = buildArgs({ mode: 'new' })
    expect(args).toEqual([...CLAUDE_ARGS])
  })

  it('does not append --resume or --continue for new mode', () => {
    const args = buildArgs({ mode: 'new' })
    expect(args).not.toContain('--resume')
    expect(args).not.toContain('--continue')
  })

  it('appends extraArgs after base args for new mode', () => {
    const args = buildArgs({ mode: 'new', extraArgs: ['--foo', 'bar'] })
    const baseLen = CLAUDE_ARGS.length
    expect(args.slice(0, baseLen)).toEqual([...CLAUDE_ARGS])
    expect(args.slice(baseLen)).toEqual(['--foo', 'bar'])
  })
})

describe('buildArgs — continue mode', () => {
  it('appends --continue after base args', () => {
    const args = buildArgs({ mode: 'continue' })
    expect(args).toContain('--continue')
  })

  it('places --continue before extraArgs', () => {
    const args = buildArgs({ mode: 'continue', extraArgs: ['--extra'] })
    const continueIdx = args.indexOf('--continue')
    const extraIdx = args.indexOf('--extra')
    expect(continueIdx).toBeGreaterThan(-1)
    expect(extraIdx).toBeGreaterThan(continueIdx)
  })

  it('does not include --resume in continue mode', () => {
    const args = buildArgs({ mode: 'continue' })
    expect(args).not.toContain('--resume')
  })

  it('works with _rawArgs override', () => {
    const args = buildArgs({ mode: 'continue', _rawArgs: ['echo'] })
    expect(args).toEqual(['echo', '--continue'])
  })
})

describe('buildArgs — resume mode', () => {
  const SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

  it('appends --resume <sessionId> after base args', () => {
    const args = buildArgs({ mode: 'resume', sessionId: SESSION_ID })
    const resumeIdx = args.indexOf('--resume')
    expect(resumeIdx).toBeGreaterThan(-1)
    expect(args[resumeIdx + 1]).toBe(SESSION_ID)
  })

  it('places --resume before extraArgs', () => {
    const args = buildArgs({ mode: 'resume', sessionId: SESSION_ID, extraArgs: ['--extra'] })
    const resumeIdx = args.indexOf('--resume')
    const extraIdx = args.indexOf('--extra')
    expect(resumeIdx).toBeGreaterThan(-1)
    expect(extraIdx).toBeGreaterThan(resumeIdx + 1) // after --resume <sessionId>
  })

  it('does not include --continue in resume mode', () => {
    const args = buildArgs({ mode: 'resume', sessionId: SESSION_ID })
    expect(args).not.toContain('--continue')
  })

  it('works with _rawArgs override', () => {
    const args = buildArgs({ mode: 'resume', sessionId: SESSION_ID, _rawArgs: ['echo'] })
    expect(args).toEqual(['echo', '--resume', SESSION_ID])
  })
})

describe('buildArgs — resume mode validation', () => {
  it('throws SpawnError when sessionId is missing', () => {
    expect(() => buildArgs({ mode: 'resume' })).toThrowError(SpawnError)
  })

  it('throws SpawnError when sessionId is empty string', () => {
    expect(() => buildArgs({ mode: 'resume', sessionId: '' })).toThrowError(SpawnError)
  })

  it('error message mentions sessionId and resume', () => {
    expect(() => buildArgs({ mode: 'resume' })).toThrow(/sessionId.*resume/i)
  })

  it('thrown error has name SpawnError', () => {
    let caught: unknown
    try {
      buildArgs({ mode: 'resume' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SpawnError)
    expect((caught as SpawnError).name).toBe('SpawnError')
  })
})
