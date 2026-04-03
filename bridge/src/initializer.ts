/**
 * initializer.ts — Wait for claude's init message before bridging.
 *
 * When claude starts in `--print --output-format stream-json` mode, its
 * first stdout message is `{"type":"system","subtype":"init",...}` containing
 * session config (tools, model, session_id, etc.).
 *
 * The bridge waits for this message to confirm claude is ready, then starts
 * the bidirectional message bridge. No response to stdin is needed.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InitResult {
  /** The parsed init message from claude. */
  initMessage: Record<string, unknown>
  /** Any raw JSON lines that arrived before the init message (e.g., hook events). */
  preInitMessages: string[]
}

export class InitializeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out waiting for claude init message after ${timeoutMs}ms`)
    this.name = 'InitializeTimeoutError'
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const INITIALIZE_TIMEOUT_MS = 15_000

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Wait for claude's `system.init` message.
 *
 * Uses the iterator's `.next()` method directly (instead of `for-await`)
 * so the async generator from `createLineReader` is NOT closed on return.
 * This allows the caller to continue reading post-init messages from the
 * same iterator.
 *
 * @param iterator - An AsyncIterator of raw JSON lines
 * @param timeoutMs - Timeout in ms (default: 15000)
 * @returns The init message and any pre-init messages
 * @throws InitializeTimeoutError if no init message within timeout
 */
export async function waitForInitialize(
  iterator: AsyncIterator<string>,
  _writeToStdin?: (obj: unknown) => void, // kept for API compat, not used
  timeoutMs: number = INITIALIZE_TIMEOUT_MS,
): Promise<InitResult> {
  const preInitMessages: string[] = []

  return new Promise<InitResult>((resolve, reject) => {
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new InitializeTimeoutError(timeoutMs))
      }
    }, timeoutMs)

    const iterate = async () => {
      try {
        for (;;) {
          const result = await iterator.next()

          if (result.done) {
            if (!settled) {
              settled = true
              clearTimeout(timer)
              reject(new Error('Stream ended before init message was received'))
            }
            return
          }

          if (settled) return

          const line = result.value

          if (!line.trim()) continue

          let msg: Record<string, unknown>
          try {
            msg = JSON.parse(line) as Record<string, unknown>
          } catch {
            // Malformed JSON — skip
            continue
          }

          // Claude sends {"type":"system","subtype":"init",...} as its first message
          if (msg.type === 'system' && msg.subtype === 'init') {
            settled = true
            clearTimeout(timer)
            resolve({
              initMessage: msg,
              preInitMessages,
            })
            return
          }

          // Also accept control_request initialize (SDK mode, for forward compat)
          if (
            msg.type === 'control_request' &&
            typeof msg.request === 'object' &&
            msg.request !== null &&
            (msg.request as Record<string, unknown>).subtype === 'initialize'
          ) {
            // In SDK mode, we need to respond
            if (_writeToStdin) {
              const requestId = (msg as Record<string, unknown>).request_id as string
              _writeToStdin({
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
            }
            settled = true
            clearTimeout(timer)
            resolve({
              initMessage: msg,
              preInitMessages,
            })
            return
          }

          // Pre-init messages (hook events, etc.) — collect but don't drop
          preInitMessages.push(line)
        }
      } catch (err) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(err)
        }
      }
    }

    void iterate()
  })
}
