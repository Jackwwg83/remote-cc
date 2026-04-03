/**
 * initializer.ts — Wait for claude to be ready before bridging.
 *
 * Protocol-aware init detection: handles three startup modes:
 * 1. SDK mode: control_request (initialize) → reply control_response
 * 2. Bare mode: system.init message → ready
 * 3. Normal mode: hook_started/hook_response → liveness fallback → ready
 *
 * Does NOT add --bare to spawn (preserves normal hook/config path).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InitResult {
  /** How claude was detected as ready. */
  mode: 'sdk-initialize' | 'system-init' | 'hook-liveness' | 'any-output'
  /** All messages collected during init wait (forwarded to clients). */
  earlyMessages: string[]
}

export class InitializeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out waiting for claude output after ${timeoutMs}ms — is claude installed and configured?`)
    this.name = 'InitializeTimeoutError'
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const INITIALIZE_TIMEOUT_MS = 30_000

/** Message types that indicate claude is alive and processing. */
const LIVENESS_TYPES = new Set([
  'hook_started', 'hook_response', 'hook_progress',  // hook lifecycle
])

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Wait for claude to signal readiness via any supported init protocol.
 *
 * Uses iterator.next() directly to avoid closing the async generator.
 */
export async function waitForInitialize(
  iterator: AsyncIterator<string>,
  writeToStdin?: (obj: unknown) => void,
  timeoutMs: number = INITIALIZE_TIMEOUT_MS,
): Promise<InitResult> {
  const earlyMessages: string[] = []

  return new Promise<InitResult>((resolve, reject) => {
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new InitializeTimeoutError(timeoutMs))
      }
    }, timeoutMs)

    const done = (mode: InitResult['mode']) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ mode, earlyMessages })
    }

    const fail = (err: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    }

    const iterate = async () => {
      try {
        for (;;) {
          const result = await iterator.next()

          if (result.done) {
            fail(new Error('Claude process exited before producing any output'))
            return
          }

          if (settled) return

          const line = result.value
          if (!line.trim()) continue

          earlyMessages.push(line)

          let msg: Record<string, unknown>
          try {
            msg = JSON.parse(line) as Record<string, unknown>
          } catch {
            // Non-JSON output — still means claude is alive
            done('any-output')
            return
          }

          // Mode 1: SDK — control_request (initialize)
          if (
            msg.type === 'control_request' &&
            typeof msg.request === 'object' &&
            msg.request !== null &&
            (msg.request as Record<string, unknown>).subtype === 'initialize'
          ) {
            if (writeToStdin) {
              const requestId = msg.request_id as string
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
            }
            done('sdk-initialize')
            return
          }

          // Mode 2: Bare — system.init
          if (msg.type === 'system' && msg.subtype === 'init') {
            done('system-init')
            return
          }

          // Mode 3: Normal — hook lifecycle events = liveness
          if (
            msg.type === 'system' &&
            typeof msg.subtype === 'string' &&
            LIVENESS_TYPES.has(msg.subtype)
          ) {
            done('hook-liveness')
            return
          }

          // Any other valid JSON message — also means claude is alive
          if (typeof msg.type === 'string') {
            done('any-output')
            return
          }
        }
      } catch (err) {
        fail(err)
      }
    }

    void iterate()
  })
}
