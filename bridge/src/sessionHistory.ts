/**
 * sessionHistory.ts — Read conversation history from a session .jsonl file.
 *
 * When resuming a session, the web UI needs to display previous messages.
 * This module reads the .jsonl file and extracts user + assistant messages
 * suitable for rendering in the chat interface.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max number of historical messages to send (most recent) */
const MAX_HISTORY_MESSAGES = 50

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface HistoryMessage {
  /** The raw JSON string of the message (as it would appear in SSE data) */
  raw: string
  /** Whether this is a historical message (always true here) */
  historical: true
}

/**
 * Read conversation history for a session.
 * Returns the last N user + assistant messages as raw JSON strings,
 * ready to be broadcast via SSE.
 *
 * @param sessionId - The full session UUID
 * @returns Array of historical messages (oldest first, capped at MAX_HISTORY_MESSAGES)
 */
export async function readSessionHistory(sessionId: string): Promise<HistoryMessage[]> {
  const filePath = await findSessionFile(sessionId)
  if (!filePath) return []

  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch {
    return []
  }

  const messages: HistoryMessage[] = []
  const lines = content.split('\n')

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }

    // Only include user messages (real user input) and assistant messages
    if (obj.type === 'user') {
      const msg = obj.message as Record<string, unknown> | undefined
      if (msg && typeof msg.content === 'string' && msg.content.trim()) {
        // Real user message (plain text, not tool_result)
        messages.push({ raw: trimmed, historical: true })
      }
    } else if (obj.type === 'assistant') {
      // Assistant messages with content
      const msg = obj.message as Record<string, unknown> | undefined
      if (msg && msg.content) {
        messages.push({ raw: trimmed, historical: true })
      }
    }
  }

  // Return last N messages
  if (messages.length > MAX_HISTORY_MESSAGES) {
    return messages.slice(-MAX_HISTORY_MESSAGES)
  }
  return messages
}

// ---------------------------------------------------------------------------
// Internal: find the .jsonl file for a session ID
// ---------------------------------------------------------------------------

async function findSessionFile(sessionId: string): Promise<string | null> {
  const projectsRoot = join(homedir(), '.claude', 'projects')

  let projectDirs: string[]
  try {
    const entries = await readdir(projectsRoot, { withFileTypes: true })
    projectDirs = entries
      .filter(e => e.isDirectory())
      .map(e => join(projectsRoot, e.name))
  } catch {
    return null
  }

  // Search for {sessionId}.jsonl across all project directories
  const fileName = `${sessionId}.jsonl`
  for (const dir of projectDirs) {
    const filePath = join(dir, fileName)
    try {
      await readFile(filePath, { flag: 'r' }).then(() => {}) // existence check
      return filePath
    } catch {
      continue
    }
  }

  return null
}
