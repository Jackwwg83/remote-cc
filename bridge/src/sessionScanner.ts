/**
 * sessionScanner.ts — Scan ~/.claude/projects/ and return SessionInfo[].
 *
 * Claude Code stores sessions at:
 *   ~/.claude/projects/{cwd-hash}/{uuid}.jsonl
 *
 * Each .jsonl has one JSON object per line. We read only the first 10 lines
 * to extract session metadata (sessionId, cwd, first user message).
 *
 * Subagent sessions (lines containing "parentSessionId") are excluded.
 */

import { readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SessionInfo {
  /** Full UUID (from filename, strip .jsonl) */
  id: string
  /** first4..last4 of the UUID */
  shortId: string
  /** Project name (cwd basename) */
  project: string
  /** Full working directory path */
  cwd: string
  /** ISO timestamp (file mtime) */
  time: string
  /** First user message, truncated to 120 chars */
  summary: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Convert a project dir name back to the original cwd path.
 *
 * Claude uses a simple scheme: replace all path separators with '-'
 * and prepend '-'. So /Users/jack/foo → -Users-jack-foo.
 * We reverse this by replacing leading '-' and splitting on '-'.
 *
 * This is a best-effort fallback; the real cwd comes from session content.
 */
function decodeDirName(dirName: string): string {
  // Dir names start with '-' representing '/' on Unix
  // e.g.  -Users-jack-myproject  →  /Users/jack/myproject
  if (dirName.startsWith('-')) {
    return dirName.replace(/-/g, '/')
  }
  return dirName
}

/** Build the shortId from a UUID: first4..last4 */
function makeShortId(uuid: string): string {
  const clean = uuid.replace(/-/g, '')
  if (clean.length < 8) return uuid
  return `${clean.slice(0, 4)}..${clean.slice(-4)}`
}

/**
 * Read at most `maxLines` lines from a file using readline (no full-file read).
 * Returns the lines array. Stops early once maxLines is reached.
 */
async function readFirstLines(filePath: string, maxLines: number): Promise<string[]> {
  const lines: string[] = []

  // Verify file is accessible before creating streams
  await stat(filePath)

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })

    rl.on('line', (line) => {
      lines.push(line)
      if (lines.length >= maxLines) {
        rl.close()
        stream.destroy()
      }
    })

    rl.on('close', resolve)
    rl.on('error', reject)
    stream.on('error', reject)
  })

  return lines
}

// ---------------------------------------------------------------------------
// Core: parse a single .jsonl file
// ---------------------------------------------------------------------------

/**
 * Parse the first 10 lines of a session .jsonl file and extract metadata.
 * Returns null if the file should be skipped (subagent session, unreadable,
 * malformed, or missing required fields).
 */
async function parseSessionFile(
  filePath: string,
  uuid: string,
  mtime: Date,
  fallbackCwd: string,
): Promise<SessionInfo | null> {
  let lines: string[]

  try {
    lines = await readFirstLines(filePath, 10)
  } catch {
    // Unreadable or permission error — skip
    return null
  }

  if (lines.length === 0) return null

  let sessionId: string | undefined
  let cwd: string | undefined
  let summary: string | undefined

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    // Exclude subagent sessions: any line with "parentSessionId" field
    if (line.includes('"parentSessionId"')) return null

    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Malformed line — skip this line, continue
      continue
    }

    // Extract sessionId from any message that has it
    if (!sessionId && typeof obj.sessionId === 'string') {
      sessionId = obj.sessionId
    }

    // Extract cwd from user/system messages
    if (!cwd && typeof obj.cwd === 'string') {
      cwd = obj.cwd
    }

    // Extract first real user message as summary
    // A user message has type="user" and message.role="user" and userType="external"
    // Skip meta messages (isMeta=true) and local-command messages
    if (!summary && obj.type === 'user' && obj.isMeta !== true) {
      const msg = obj.message as Record<string, unknown> | undefined
      if (msg && typeof msg.content === 'string') {
        const content = msg.content.trim()
        // Skip internal meta/command messages that start with '<'
        if (content && !content.startsWith('<')) {
          summary = content.slice(0, 120)
        }
      }
    }
  }

  // Must have at minimum a sessionId (from content or fallback to filename uuid)
  const finalId = sessionId ?? uuid
  const finalCwd = cwd ?? fallbackCwd

  return {
    id: finalId,
    shortId: makeShortId(finalId),
    project: basename(finalCwd),
    cwd: finalCwd,
    time: mtime.toISOString(),
    summary: summary ?? '',
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan Claude Code session files and return structured metadata.
 *
 * @param projectDir - Optional: limit scan to this specific project directory
 *                     (full path like `~/.claude/projects/-Users-jack-myapp`).
 *                     If omitted, scans all projects under `~/.claude/projects/`.
 * @returns SessionInfo[] sorted by time descending (most recent first).
 */
export async function scanSessions(projectDir?: string): Promise<SessionInfo[]> {
  const claudeProjectsRoot = join(homedir(), '.claude', 'projects')

  // Determine which project directories to scan
  let projectDirs: string[]

  if (projectDir) {
    // Caller specified a single project directory
    projectDirs = [projectDir]
  } else {
    // Scan all subdirectories under ~/.claude/projects/
    let entries: Dirent<string>[]
    try {
      entries = await readdir(claudeProjectsRoot, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      // ~/.claude/projects/ doesn't exist or is unreadable
      return []
    }
    projectDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => join(claudeProjectsRoot, e.name))
  }

  // Process each project directory in parallel
  const perProjectResults = await Promise.all(
    projectDirs.map((dir) => scanProjectDir(dir)),
  )

  // Flatten, filter nulls, sort by time descending
  const sessions: SessionInfo[] = perProjectResults
    .flat()
    .filter((s): s is SessionInfo => s !== null)

  sessions.sort((a, b) => {
    // Descending: most recent first
    return new Date(b.time).getTime() - new Date(a.time).getTime()
  })

  return sessions
}

/**
 * Scan a single project directory for .jsonl session files.
 * Returns an array of SessionInfo (nulls already filtered).
 */
async function scanProjectDir(dir: string): Promise<SessionInfo[]> {
  let entries: Dirent<string>[]

  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return []
  }

  // The fallback cwd decoded from the directory name
  const fallbackCwd = decodeDirName(basename(dir))

  // Process all .jsonl files in this directory in parallel
  const results = await Promise.all(
    entries
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map(async (e): Promise<SessionInfo | null> => {
        const filePath = join(dir, e.name)
        const uuid = e.name.slice(0, -'.jsonl'.length)

        let fileStat: Awaited<ReturnType<typeof stat>>
        try {
          fileStat = await stat(filePath)
        } catch {
          return null
        }

        return parseSessionFile(filePath, uuid, fileStat.mtime, fallbackCwd)
      }),
  )

  return results.filter((s): s is SessionInfo => s !== null)
}
