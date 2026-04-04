/**
 * messageCache.ts — Fixed-size ring buffer for message caching.
 *
 * Used to replay missed messages when a client reconnects.
 * Each message is stored with a monotonically increasing sequence number.
 * The buffer has a fixed capacity (default 200); oldest messages are
 * evicted when the buffer is full.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReplayEntry {
  seq: number
  message: string
}

export interface MessageCache {
  /** Add a message with its sequence number. */
  push(message: string, seq: number): void
  /** Get all messages with seq > fromSeq, in order. */
  replay(fromSeq: number): string[]
  /** Get all messages with seq > fromSeq, in order, including seq numbers. */
  replayWithSeq(fromSeq: number): ReplayEntry[]
  /** Return the latest sequence number, or 0 if empty. */
  currentSeq(): number
  /** Clear all cached messages and reset state. */
  clear(): void
}

interface CacheEntry {
  message: string
  seq: number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a fixed-size ring buffer message cache.
 *
 * @param maxMessages - Maximum number of messages to retain (default 200)
 */
export function createMessageCache(maxMessages = 200): MessageCache {
  const buffer: (CacheEntry | undefined)[] = new Array(maxMessages)
  let writeIndex = 0
  let count = 0
  let latestSeq = 0

  return {
    push(message: string, seq: number): void {
      buffer[writeIndex] = { message, seq }
      writeIndex = (writeIndex + 1) % maxMessages
      if (count < maxMessages) count++
      latestSeq = seq
    },

    replay(fromSeq: number): string[] {
      return this.replayWithSeq(fromSeq).map((e) => e.message)
    },

    replayWithSeq(fromSeq: number): ReplayEntry[] {
      const result: ReplayEntry[] = []

      // Read entries from oldest to newest
      // Oldest entry is at (writeIndex - count + maxMessages) % maxMessages
      const startIdx = (writeIndex - count + maxMessages) % maxMessages

      for (let i = 0; i < count; i++) {
        const entry = buffer[(startIdx + i) % maxMessages]
        if (entry && entry.seq > fromSeq) {
          result.push({ seq: entry.seq, message: entry.message })
        }
      }

      return result
    },

    currentSeq(): number {
      return latestSeq
    },

    clear(): void {
      buffer.fill(undefined)
      writeIndex = 0
      count = 0
      latestSeq = 0
    },
  }
}
