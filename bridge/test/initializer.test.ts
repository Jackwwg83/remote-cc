/**
 * Tests for initializer.ts
 *
 * Strategy:
 * - Use PassThrough streams + createLineReader to simulate claude stdout.
 * - Capture writeToStdin calls to verify the response message.
 * - Test: normal handshake, timeout, pre-init messages, request_id passthrough,
 *   malformed JSON lines, stream ends before initialize.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { PassThrough } from 'node:stream'
import { createLineReader } from '../src/lineReader.js'
import {
  waitForInitialize,
  InitializeTimeoutError,
  INITIALIZE_TIMEOUT_MS,
} from '../src/initializer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a PassThrough stream and an async iterator of lines from it. */
function createTestStream() {
  const stream = new PassThrough()
  const reader = createLineReader(stream)
  const iterator = reader[Symbol.asyncIterator]()
  return { stream, iterator }
}

/** Push a JSON message as a line to the stream. */
function pushMessage(stream: PassThrough, msg: unknown) {
  stream.push(JSON.stringify(msg) + '\n')
}

/** Build a standard initialize control_request. */
function makeInitRequest(requestId = 'req_init_001') {
  return {
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'initialize',
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('waitForInitialize', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should complete handshake on a normal initialize request', async () => {
    const { stream, iterator } = createTestStream()
    const writtenMessages: unknown[] = []
    const writeToStdin = (obj: unknown) => writtenMessages.push(obj)

    // Push the initialize request
    pushMessage(stream, makeInitRequest('req_abc'))
    stream.push(null)

    const result = await waitForInitialize(iterator, writeToStdin)

    // Verify result
    expect(result.requestId).toBe('req_abc')
    expect(result.preInitMessages).toEqual([])

    // Verify response was written
    expect(writtenMessages).toHaveLength(1)
    const response = writtenMessages[0] as Record<string, unknown>
    expect(response.type).toBe('control_response')

    const inner = response.response as Record<string, unknown>
    expect(inner.subtype).toBe('success')
    expect(inner.request_id).toBe('req_abc')

    const payload = inner.response as Record<string, unknown>
    expect(payload.commands).toEqual([])
    expect(payload.agents).toEqual([])
    expect(payload.output_style).toBe('normal')
    expect(payload.available_output_styles).toEqual(['normal'])
    expect(payload.models).toEqual([])
    expect(payload.account).toEqual({})
    expect(typeof payload.pid).toBe('number')
  })

  it('should echo back the correct request_id', async () => {
    const { stream, iterator } = createTestStream()
    const writtenMessages: unknown[] = []
    const writeToStdin = (obj: unknown) => writtenMessages.push(obj)

    const customId = 'req_custom_id_12345'
    pushMessage(stream, makeInitRequest(customId))
    stream.push(null)

    const result = await waitForInitialize(iterator, writeToStdin)

    expect(result.requestId).toBe(customId)
    const response = writtenMessages[0] as Record<string, unknown>
    const inner = response.response as Record<string, unknown>
    expect(inner.request_id).toBe(customId)
  })

  it('should collect pre-init messages without dropping them', async () => {
    const { stream, iterator } = createTestStream()
    const writtenMessages: unknown[] = []
    const writeToStdin = (obj: unknown) => writtenMessages.push(obj)

    // System status messages arrive before initialize
    const statusMsg1 = { type: 'status', status: 'loading_mcp' }
    const statusMsg2 = { type: 'system', message: 'Starting hooks...' }
    const authMsg = { type: 'auth_status', authenticated: true }

    pushMessage(stream, statusMsg1)
    pushMessage(stream, statusMsg2)
    pushMessage(stream, authMsg)
    pushMessage(stream, makeInitRequest('req_init_after_status'))
    stream.push(null)

    const result = await waitForInitialize(iterator, writeToStdin)

    expect(result.requestId).toBe('req_init_after_status')
    expect(result.preInitMessages).toHaveLength(3)
    expect(JSON.parse(result.preInitMessages[0])).toEqual(statusMsg1)
    expect(JSON.parse(result.preInitMessages[1])).toEqual(statusMsg2)
    expect(JSON.parse(result.preInitMessages[2])).toEqual(authMsg)

    // Only one response written (the initialize response)
    expect(writtenMessages).toHaveLength(1)
  })

  it('should time out if no initialize request arrives', async () => {
    const { stream, iterator } = createTestStream()
    const writeToStdin = vi.fn()

    // Push non-initialize messages only, don't end the stream
    pushMessage(stream, { type: 'status', status: 'loading' })

    await expect(
      waitForInitialize(iterator, writeToStdin, 100), // short timeout for test
    ).rejects.toThrow(InitializeTimeoutError)

    // No response should have been written
    expect(writeToStdin).not.toHaveBeenCalled()

    // Clean up stream
    stream.destroy()
  })

  it('should reject if stream ends before initialize request', async () => {
    const { stream, iterator } = createTestStream()
    const writeToStdin = vi.fn()

    // End the stream without sending initialize
    pushMessage(stream, { type: 'status', status: 'loading' })
    stream.push(null)

    await expect(
      waitForInitialize(iterator, writeToStdin, 5000),
    ).rejects.toThrow('Stream ended before initialize request was received')

    expect(writeToStdin).not.toHaveBeenCalled()
  })

  it('should skip malformed JSON lines gracefully', async () => {
    const { stream, iterator } = createTestStream()
    const writtenMessages: unknown[] = []
    const writeToStdin = (obj: unknown) => writtenMessages.push(obj)

    // Push garbage, then a valid init
    stream.push('this is not json\n')
    stream.push('{broken json\n')
    pushMessage(stream, makeInitRequest('req_after_garbage'))
    stream.push(null)

    const result = await waitForInitialize(iterator, writeToStdin)

    expect(result.requestId).toBe('req_after_garbage')
    // Malformed lines are skipped, not collected as pre-init messages
    expect(result.preInitMessages).toEqual([])
    expect(writtenMessages).toHaveLength(1)
  })

  it('should skip empty lines', async () => {
    const { stream, iterator } = createTestStream()
    const writtenMessages: unknown[] = []
    const writeToStdin = (obj: unknown) => writtenMessages.push(obj)

    stream.push('\n')
    stream.push('  \n')
    pushMessage(stream, makeInitRequest('req_after_empty'))
    stream.push(null)

    const result = await waitForInitialize(iterator, writeToStdin)

    expect(result.requestId).toBe('req_after_empty')
    expect(result.preInitMessages).toEqual([])
  })

  it('should ignore control_requests with non-initialize subtypes', async () => {
    const { stream, iterator } = createTestStream()
    const writtenMessages: unknown[] = []
    const writeToStdin = (obj: unknown) => writtenMessages.push(obj)

    // A different control_request first
    const interruptReq = {
      type: 'control_request',
      request_id: 'req_interrupt',
      request: { subtype: 'interrupt' },
    }
    pushMessage(stream, interruptReq)
    pushMessage(stream, makeInitRequest('req_real_init'))
    stream.push(null)

    const result = await waitForInitialize(iterator, writeToStdin)

    expect(result.requestId).toBe('req_real_init')
    // The interrupt request should be in pre-init messages (as raw JSON string)
    expect(result.preInitMessages).toHaveLength(1)
    expect(JSON.parse(result.preInitMessages[0])).toEqual(interruptReq)
  })

  it('should include process.pid in the response', async () => {
    const { stream, iterator } = createTestStream()
    const writtenMessages: unknown[] = []
    const writeToStdin = (obj: unknown) => writtenMessages.push(obj)

    pushMessage(stream, makeInitRequest('req_pid_check'))
    stream.push(null)

    await waitForInitialize(iterator, writeToStdin)

    const response = writtenMessages[0] as Record<string, unknown>
    const inner = response.response as Record<string, unknown>
    const payload = inner.response as Record<string, unknown>
    expect(payload.pid).toBe(process.pid)
  })

  it('should use default timeout from constant', () => {
    expect(INITIALIZE_TIMEOUT_MS).toBe(10_000)
  })

  it('should handle delayed initialize arriving before timeout', async () => {
    const { stream, iterator } = createTestStream()
    const writtenMessages: unknown[] = []
    const writeToStdin = (obj: unknown) => writtenMessages.push(obj)

    // Start waiting, then push init after a small delay
    const promise = waitForInitialize(iterator, writeToStdin, 2000)

    // Status first
    pushMessage(stream, { type: 'system', message: 'loading' })

    // Delay, then init
    await new Promise(r => setTimeout(r, 50))
    pushMessage(stream, makeInitRequest('req_delayed'))
    stream.push(null)

    const result = await promise

    expect(result.requestId).toBe('req_delayed')
    expect(result.preInitMessages).toHaveLength(1)
    expect(writtenMessages).toHaveLength(1)
  })

  it('should allow reading post-init messages from the same iterator', async () => {
    // This is the critical test: after waitForInitialize returns, the
    // iterator must NOT be closed — callers continue reading normal messages.
    const { stream, iterator } = createTestStream()
    const writtenMessages: unknown[] = []
    const writeToStdin = (obj: unknown) => writtenMessages.push(obj)

    // Push init, then post-init messages
    pushMessage(stream, makeInitRequest('req_post'))

    const result = await waitForInitialize(iterator, writeToStdin)
    expect(result.requestId).toBe('req_post')

    // Now push messages AFTER init completes — the iterator must still work
    const postMsg1 = { type: 'assistant', message: { content: 'hello' } }
    const postMsg2 = { type: 'result', result: 42 }
    pushMessage(stream, postMsg1)
    pushMessage(stream, postMsg2)

    // Read them from the same iterator
    const next1 = await iterator.next()
    expect(next1.done).toBe(false)
    expect(JSON.parse(next1.value!)).toEqual(postMsg1)

    const next2 = await iterator.next()
    expect(next2.done).toBe(false)
    expect(JSON.parse(next2.value!)).toEqual(postMsg2)

    // End the stream and verify iterator finishes
    stream.push(null)
    const next3 = await iterator.next()
    expect(next3.done).toBe(true)
  })
})
