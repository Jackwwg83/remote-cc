/**
 * Tests for sessionScanner.ts
 *
 * Strategy:
 * - Create temp directories mimicking ~/.claude/projects/{hash}/{uuid}.jsonl
 * - Pass the temp dir as projectDir to scanSessions() to isolate from real data
 * - Test all extraction, filtering, sorting, and edge-case behaviors
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanSessions, type SessionInfo } from '../src/sessionScanner.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A normal user session .jsonl content. */
const NORMAL_SESSION = (uuid: string, cwd: string, userMsg: string) => [
  JSON.stringify({ type: 'system', subtype: 'init', sessionId: uuid, cwd }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: userMsg }, session_id: uuid }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] }, session_id: uuid }),
].join('\n') + '\n'

/** A subagent session has parentSessionId in first 10 lines. */
const SUBAGENT_SESSION = (uuid: string, parentId: string, cwd: string) => [
  JSON.stringify({ type: 'system', subtype: 'init', sessionId: uuid, parentSessionId: parentId, cwd }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'Subtask work' }, session_id: uuid }),
].join('\n') + '\n'

/** A meta user message (isMeta: true) should be skipped; only real messages become summary. */
const SESSION_WITH_META_FIRST = (uuid: string, cwd: string) => [
  JSON.stringify({ type: 'system', subtype: 'init', sessionId: uuid, cwd }),
  JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: '<meta command>' }, session_id: uuid }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'Real user message' }, session_id: uuid }),
].join('\n') + '\n'

/** Content with no user message at all. */
const SESSION_NO_USER_MSG = (uuid: string, cwd: string) => [
  JSON.stringify({ type: 'system', subtype: 'init', sessionId: uuid, cwd }),
].join('\n') + '\n'

/** Corrupted/malformed jsonl. */
const MALFORMED_CONTENT = 'this is not json\n{broken json\n'

/** Empty file. */
const EMPTY_CONTENT = ''

// ---------------------------------------------------------------------------
// Test UUIDs
// ---------------------------------------------------------------------------

const UUID_A = 'aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb'
const UUID_B = 'bbbbcccc-dddd-eeee-ffff-aaaabbbbcccc'
const UUID_C = 'ccccdddd-eeee-ffff-aaaa-bbbbccccdddd'
const UUID_SUB = '11112222-3333-4444-5555-666677778888'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string

async function createSessionFile(
  dir: string,
  uuid: string,
  content: string,
  mtime?: Date,
): Promise<string> {
  const filePath = join(dir, `${uuid}.jsonl`)
  await writeFile(filePath, content, 'utf8')
  if (mtime) {
    await utimes(filePath, mtime, mtime)
  }
  return filePath
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'sessionScanner-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scanSessions — basic scanning', () => {
  it('returns a SessionInfo for a valid .jsonl file', async () => {
    await createSessionFile(tmpDir, UUID_A, NORMAL_SESSION(UUID_A, '/home/jack/myapp', 'Hello Claude'))

    const results = await scanSessions(tmpDir)

    expect(results).toHaveLength(1)
    const s = results[0]
    expect(s.id).toBe(UUID_A)
    expect(s.cwd).toBe('/home/jack/myapp')
    expect(s.project).toBe('myapp')
    expect(s.summary).toBe('Hello Claude')
    expect(s.time).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('returns multiple sessions from the same directory', async () => {
    await createSessionFile(tmpDir, UUID_A, NORMAL_SESSION(UUID_A, '/home/jack/app', 'First session'))
    await createSessionFile(tmpDir, UUID_B, NORMAL_SESSION(UUID_B, '/home/jack/app', 'Second session'))

    const results = await scanSessions(tmpDir)

    expect(results).toHaveLength(2)
    const ids = results.map((s) => s.id)
    expect(ids).toContain(UUID_A)
    expect(ids).toContain(UUID_B)
  })

  it('ignores non-.jsonl files', async () => {
    await createSessionFile(tmpDir, UUID_A, NORMAL_SESSION(UUID_A, '/home/jack/app', 'Valid'))
    await writeFile(join(tmpDir, 'notes.txt'), 'ignore me')
    await writeFile(join(tmpDir, 'data.json'), '{}')

    const results = await scanSessions(tmpDir)
    expect(results).toHaveLength(1)
  })
})

describe('scanSessions — subagent filtering', () => {
  it('excludes sessions with parentSessionId in first 10 lines', async () => {
    await createSessionFile(tmpDir, UUID_SUB, SUBAGENT_SESSION(UUID_SUB, UUID_A, '/home/jack/app'))

    const results = await scanSessions(tmpDir)

    expect(results).toHaveLength(0)
  })

  it('keeps normal sessions alongside excluded subagent sessions', async () => {
    await createSessionFile(tmpDir, UUID_A, NORMAL_SESSION(UUID_A, '/home/jack/app', 'Main session'))
    await createSessionFile(tmpDir, UUID_SUB, SUBAGENT_SESSION(UUID_SUB, UUID_A, '/home/jack/app'))

    const results = await scanSessions(tmpDir)

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe(UUID_A)
  })
})

describe('scanSessions — sorting', () => {
  it('returns sessions sorted by time descending (most recent first)', async () => {
    const older = new Date('2024-01-01T10:00:00.000Z')
    const newer = new Date('2025-06-15T12:00:00.000Z')

    await createSessionFile(tmpDir, UUID_A, NORMAL_SESSION(UUID_A, '/home/jack/app', 'Older'), older)
    await createSessionFile(tmpDir, UUID_B, NORMAL_SESSION(UUID_B, '/home/jack/app', 'Newer'), newer)

    const results = await scanSessions(tmpDir)

    expect(results).toHaveLength(2)
    // Newer time should come first
    expect(new Date(results[0].time) >= new Date(results[1].time)).toBe(true)
    expect(results[0].summary).toBe('Newer')
    expect(results[1].summary).toBe('Older')
  })

  it('sorts three sessions correctly', async () => {
    const t1 = new Date('2024-01-01T00:00:00.000Z')
    const t2 = new Date('2024-06-01T00:00:00.000Z')
    const t3 = new Date('2025-01-01T00:00:00.000Z')

    await createSessionFile(tmpDir, UUID_A, NORMAL_SESSION(UUID_A, '/p', 'First'), t1)
    await createSessionFile(tmpDir, UUID_B, NORMAL_SESSION(UUID_B, '/p', 'Second'), t2)
    await createSessionFile(tmpDir, UUID_C, NORMAL_SESSION(UUID_C, '/p', 'Third'), t3)

    const results = await scanSessions(tmpDir)

    expect(results.map((s) => s.summary)).toEqual(['Third', 'Second', 'First'])
  })
})

describe('scanSessions — CWD extraction', () => {
  it('extracts cwd from session file content', async () => {
    const expectedCwd = '/Users/jack/projects/my-special-project'
    await createSessionFile(tmpDir, UUID_A, NORMAL_SESSION(UUID_A, expectedCwd, 'Hello'))

    const results = await scanSessions(tmpDir)

    expect(results[0].cwd).toBe(expectedCwd)
    expect(results[0].project).toBe('my-special-project')
  })

  it('uses directory name as fallback cwd when content has no cwd', async () => {
    // Write a session file with no cwd field in the content
    const content = JSON.stringify({ type: 'system', subtype: 'init', sessionId: UUID_A }) + '\n'
    await createSessionFile(tmpDir, UUID_A, content)

    const results = await scanSessions(tmpDir)

    expect(results).toHaveLength(1)
    // cwd comes from the dir name via decodeDirName; since tmpDir has a random name
    // we just verify it's truthy and project is derived from it
    expect(results[0].cwd).toBeTruthy()
    expect(results[0].project).toBeTruthy()
  })
})

describe('scanSessions — summary extraction', () => {
  it('uses the first user message as summary', async () => {
    await createSessionFile(tmpDir, UUID_A, NORMAL_SESSION(UUID_A, '/p', 'My first question'))

    const results = await scanSessions(tmpDir)

    expect(results[0].summary).toBe('My first question')
  })

  it('truncates summary to 120 characters', async () => {
    const longMsg = 'A'.repeat(200)
    await createSessionFile(tmpDir, UUID_A, NORMAL_SESSION(UUID_A, '/p', longMsg))

    const results = await scanSessions(tmpDir)

    expect(results[0].summary).toHaveLength(120)
    expect(results[0].summary).toBe('A'.repeat(120))
  })

  it('skips meta user messages (isMeta: true) when finding summary', async () => {
    await createSessionFile(tmpDir, UUID_A, SESSION_WITH_META_FIRST(UUID_A, '/p'))

    const results = await scanSessions(tmpDir)

    expect(results[0].summary).toBe('Real user message')
  })

  it('skips user messages starting with "<" (internal commands)', async () => {
    const content = [
      JSON.stringify({ type: 'system', subtype: 'init', sessionId: UUID_A, cwd: '/p' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '<cmd>internal</cmd>' }, session_id: UUID_A }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Visible message' }, session_id: UUID_A }),
    ].join('\n') + '\n'
    await createSessionFile(tmpDir, UUID_A, content)

    const results = await scanSessions(tmpDir)

    expect(results[0].summary).toBe('Visible message')
  })

  it('returns empty string summary when no user message found', async () => {
    await createSessionFile(tmpDir, UUID_A, SESSION_NO_USER_MSG(UUID_A, '/p'))

    const results = await scanSessions(tmpDir)

    expect(results[0].summary).toBe('')
  })
})

describe('scanSessions — shortId generation', () => {
  it('generates shortId as first4..last4 of UUID with dashes stripped', async () => {
    await createSessionFile(tmpDir, UUID_A, NORMAL_SESSION(UUID_A, '/p', 'Hi'))

    const results = await scanSessions(tmpDir)

    // UUID_A = 'aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb'
    // clean  = 'aaaabbbbccccddddeeeeffffaaaabbbb'
    // short  = 'aaaa..bbbb'
    expect(results[0].shortId).toBe('aaaa..bbbb')
  })

  it('generates correct shortId for a different UUID', async () => {
    await createSessionFile(tmpDir, UUID_B, NORMAL_SESSION(UUID_B, '/p', 'Hi'))

    const results = await scanSessions(tmpDir)

    // UUID_B = 'bbbbcccc-dddd-eeee-ffff-aaaabbbbcccc'
    // clean  = 'bbbbccccddddeeeeffffaaaabbbbcccc'
    // short  = 'bbbb..cccc'
    expect(results[0].shortId).toBe('bbbb..cccc')
  })
})

describe('scanSessions — empty directory', () => {
  it('returns empty array when directory has no .jsonl files', async () => {
    const results = await scanSessions(tmpDir)
    expect(results).toEqual([])
  })

  it('returns empty array for a directory with only non-.jsonl files', async () => {
    await writeFile(join(tmpDir, 'readme.txt'), 'nothing here')
    await writeFile(join(tmpDir, 'config.json'), '{}')

    const results = await scanSessions(tmpDir)
    expect(results).toEqual([])
  })
})

describe('scanSessions — malformed files', () => {
  it('skips a completely corrupted .jsonl file gracefully', async () => {
    await createSessionFile(tmpDir, UUID_A, MALFORMED_CONTENT)
    await createSessionFile(tmpDir, UUID_B, NORMAL_SESSION(UUID_B, '/p', 'Valid session'))

    const results = await scanSessions(tmpDir)

    // UUID_A is malformed — no sessionId extractable but it may still return with uuid fallback
    // UUID_B must always be present
    const validResult = results.find((s) => s.id === UUID_B)
    expect(validResult).toBeDefined()
    expect(validResult!.summary).toBe('Valid session')
  })

  it('skips an empty .jsonl file', async () => {
    await createSessionFile(tmpDir, UUID_A, EMPTY_CONTENT)
    await createSessionFile(tmpDir, UUID_B, NORMAL_SESSION(UUID_B, '/p', 'Only valid'))

    const results = await scanSessions(tmpDir)

    // UUID_A (empty) should be skipped; UUID_B should be present
    const ids = results.map((s) => s.id)
    expect(ids).toContain(UUID_B)
    expect(ids).not.toContain(UUID_A)
  })

  it('handles a mix of corrupted lines and valid lines in the same file', async () => {
    const mixedContent = [
      'not valid json',
      JSON.stringify({ type: 'system', subtype: 'init', sessionId: UUID_A, cwd: '/p' }),
      '{broken',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'After garbage' }, session_id: UUID_A }),
    ].join('\n') + '\n'

    await createSessionFile(tmpDir, UUID_A, mixedContent)

    const results = await scanSessions(tmpDir)

    // Should still extract valid data from the good lines
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe(UUID_A)
    expect(results[0].cwd).toBe('/p')
    expect(results[0].summary).toBe('After garbage')
  })
})

describe('scanSessions — projectDir parameter', () => {
  it('only scans the specified projectDir, not other directories', async () => {
    const otherDir = await mkdtemp(join(tmpdir(), 'sessionScanner-other-'))

    try {
      await createSessionFile(tmpDir, UUID_A, NORMAL_SESSION(UUID_A, '/p/target', 'In target dir'))
      await createSessionFile(otherDir, UUID_B, NORMAL_SESSION(UUID_B, '/p/other', 'In other dir'))

      const results = await scanSessions(tmpDir)

      expect(results).toHaveLength(1)
      expect(results[0].cwd).toBe('/p/target')
    } finally {
      await rm(otherDir, { recursive: true, force: true })
    }
  })

  it('returns empty array when projectDir does not exist', async () => {
    const nonExistentDir = join(tmpdir(), 'this-dir-does-not-exist-' + Date.now())
    const results = await scanSessions(nonExistentDir)
    expect(results).toEqual([])
  })
})
