/**
 * initializer.ts — Handle the initialize handshake with claude.
 *
 * When claude starts in stream-json mode, its first stdout message is a
 * `control_request` with `subtype: 'initialize'`. The bridge must reply
 * with a `control_response` containing session configuration, otherwise
 * claude will not process any user messages.
 *
 * This module reads lines from claude's stdout, detects the initialize
 * request, sends the response to stdin, and transparently yields all
 * other messages (system status, etc.) that arrive before the handshake.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Messages received before initialize completes — passed through, not dropped. */
export interface InitializeResult {
  /** The request_id from the initialize control_request. */
  requestId: string
  /** Any messages that arrived before the initialize request. */
  preInitMessages: unknown[]
}

export class InitializeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out waiting for initialize request after ${timeoutMs}ms`)
    this.name = 'InitializeTimeoutError'
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const INITIALIZE_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Wait for claude's initialize handshake and reply.
 *
 * Reads lines from the provided async iterable, looking for the first
 * `control_request` with `subtype: 'initialize'`. All messages received
 * before the initialize request are collected and returned (not dropped).
 *
 * When the initialize request is found, a `control_response` is written
 * to claude's stdin via the provided `writeToStdin` callback.
 *
 * @param lines - Async iterable of raw JSON lines from claude stdout
 * @param writeToStdin - Callback to write a JSON object to claude stdin
 * @param timeoutMs - Timeout in ms (default: 10000)
 * @returns The request_id and any pre-init messages
 * @throws InitializeTimeoutError if no initialize request within timeout
 */
export async function waitForInitialize(
  lines: AsyncIterable<string>,
  writeToStdin: (obj: unknown) => void,
  timeoutMs: number = INITIALIZE_TIMEOUT_MS,
): Promise<InitializeResult> {
  const preInitMessages: unknown[] = []

  // Race the line iteration against a timeout
  return new Promise<InitializeResult>((resolve, reject) => {
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new InitializeTimeoutError(timeoutMs))
      }
    }, timeoutMs)

    const iterate = async () => {
      try {
        for await (const line of lines) {
          if (settled) return

          // Skip empty lines
          if (!line.trim()) continue

          let msg: Record<string, unknown>
          try {
            msg = JSON.parse(line) as Record<string, unknown>
          } catch {
            // Malformed JSON — skip (per protocol-spec §6: log warning, don't crash)
            continue
          }

          // Check if this is the initialize control_request
          if (
            msg.type === 'control_request' &&
            typeof msg.request === 'object' &&
            msg.request !== null &&
            (msg.request as Record<string, unknown>).subtype === 'initialize'
          ) {
            const requestId = msg.request_id as string

            // Send the initialize response
            writeToStdin({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: requestId,
                response: {
                  commands: [],
                  agents: [],
                  output_style: 'normal',
                  available_output_styles: ['normal'],
                  models: [],
                  account: {},
                  pid: process.pid,
                },
              },
            })

            if (!settled) {
              settled = true
              clearTimeout(timer)
              resolve({ requestId, preInitMessages })
            }
            return
          }

          // Not the initialize request — collect as pre-init message
          preInitMessages.push(msg)
        }

        // Stream ended without initialize
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error('Stream ended before initialize request was received'))
        }
      } catch (err) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(err)
        }
      }
    }

    iterate()
  })
}
