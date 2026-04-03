/**
 * lineReader.ts — Buffered line reader/writer for stream-json communication.
 *
 * Claude's stdout emits `data` events that do NOT guarantee complete lines.
 * A single JSON message may arrive split across multiple chunks, or multiple
 * messages may arrive in a single chunk. This module buffers raw bytes and
 * yields complete lines (delimited by '\n').
 *
 * Also provides a writeLine helper that serializes an object as JSON + '\n'
 * for writing to claude's stdin.
 */

import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

// ---------------------------------------------------------------------------
// createLineReader — async iterable that yields complete lines from a stream
// ---------------------------------------------------------------------------

/**
 * Create an async iterable that yields complete lines from a readable stream.
 *
 * Buffers incoming data chunks and splits on '\n' boundaries. When the stream
 * ends, any remaining content in the buffer is yielded as a final line
 * (handles the case where the last line has no trailing newline).
 *
 * @param stream - A Readable stream (e.g. ClaudeProcess.stdout)
 * @returns An AsyncIterable that yields one complete line per iteration (without '\n')
 */
export async function* createLineReader(stream: Readable): AsyncIterable<string> {
  let buffer = ''
  const decoder = new StringDecoder('utf8')

  // We need to bridge Node's event-based stream API into an async iterator.
  // Use a queue of resolved/pending promises to do so.
  const queue: string[] = []
  let done = false
  let error: Error | null = null

  // resolve/reject for the "waiter" — the consumer blocked on next()
  let notify: (() => void) | null = null

  const flush = () => {
    // Extract all complete lines from buffer
    let idx: number
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      queue.push(line)
    }
  }

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    flush()
    // Wake up the consumer if it's waiting
    if (notify) {
      const n = notify
      notify = null
      n()
    }
  }

  const onEnd = () => {
    // Flush any remaining bytes held by the decoder
    buffer += decoder.end()
    // Yield any remaining buffer content as the last line
    if (buffer.length > 0) {
      queue.push(buffer)
      buffer = ''
    }
    done = true
    if (notify) {
      const n = notify
      notify = null
      n()
    }
  }

  const onError = (err: Error) => {
    error = err
    done = true
    if (notify) {
      const n = notify
      notify = null
      n()
    }
  }

  stream.on('data', onData)
  stream.on('end', onEnd)
  stream.on('error', onError)

  // Yield lines as they become available
  try {
    for (;;) {
      // Drain the queue first
      while (queue.length > 0) {
        yield queue.shift()!
      }

      // If stream is done and queue is empty, we're finished
      if (done) {
        // Check for error
        if (error) {
          throw error
        }
        return
      }

      // Wait for more data
      await new Promise<void>((resolve) => {
        notify = resolve
      })
    }
  } finally {
    // Clean up listeners when the generator is closed (return/throw) or
    // when the consumer stops iterating (for-await break/return).
    stream.removeListener('data', onData)
    stream.removeListener('end', onEnd)
    stream.removeListener('error', onError)
  }
}

// ---------------------------------------------------------------------------
// writeLine — serialize an object as JSON + '\n' and write to a stream
// ---------------------------------------------------------------------------

/**
 * Write a JSON-serialized object followed by '\n' to a writable stream.
 *
 * @param stream - A Writable stream (e.g. ClaudeProcess.stdin)
 * @param obj - Any JSON-serializable value
 */
export function writeLine(stream: Writable, obj: unknown): void {
  stream.write(JSON.stringify(obj) + '\n')
}
