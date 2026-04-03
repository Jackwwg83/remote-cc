import { describe, it, expect, vi } from 'vitest'
import { waitForInitialize, InitializeTimeoutError } from '../src/initializer.js'

function makeIterator(lines: string[]): AsyncIterator<string> {
  let i = 0
  return {
    async next() {
      if (i < lines.length) return { value: lines[i++], done: false }
      return { value: undefined as unknown as string, done: true }
    },
  }
}

describe('waitForInitialize', () => {
  it('should resolve on system.init (bare mode)', async () => {
    const initMsg = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test' })
    const iter = makeIterator([initMsg])
    const result = await waitForInitialize(iter, undefined, 5000)
    expect(result.mode).toBe('system-init')
    expect(result.earlyMessages).toHaveLength(1)
  })

  it('should resolve on hook_started (normal mode)', async () => {
    const hookMsg = JSON.stringify({ type: 'system', subtype: 'hook_started', hook_id: 'h1' })
    const iter = makeIterator([hookMsg])
    const result = await waitForInitialize(iter, undefined, 5000)
    expect(result.mode).toBe('hook-liveness')
  })

  it('should resolve on hook_response (normal mode)', async () => {
    const hookMsg = JSON.stringify({ type: 'system', subtype: 'hook_response', hook_id: 'h1' })
    const iter = makeIterator([hookMsg])
    const result = await waitForInitialize(iter, undefined, 5000)
    expect(result.mode).toBe('hook-liveness')
  })

  it('should resolve on control_request initialize (SDK mode)', async () => {
    const writeToStdin = vi.fn()
    const initMsg = JSON.stringify({
      type: 'control_request',
      request_id: 'req_1',
      request: { subtype: 'initialize' }
    })
    const iter = makeIterator([initMsg])
    const result = await waitForInitialize(iter, writeToStdin, 5000)
    expect(result.mode).toBe('sdk-initialize')
    expect(writeToStdin).toHaveBeenCalledTimes(1)
    const response = writeToStdin.mock.calls[0][0] as Record<string, unknown>
    expect(response.type).toBe('control_response')
  })

  it('should include pid in SDK mode response', async () => {
    const writeToStdin = vi.fn()
    const initMsg = JSON.stringify({
      type: 'control_request',
      request_id: 'req_2',
      request: { subtype: 'initialize' }
    })
    const iter = makeIterator([initMsg])
    await waitForInitialize(iter, writeToStdin, 5000)
    const response = writeToStdin.mock.calls[0][0] as any
    expect(response.response.response.pid).toBe(process.pid)
  })

  it('should resolve on any valid JSON message as fallback', async () => {
    const msg = JSON.stringify({ type: 'assistant', message: { content: 'hi' } })
    const iter = makeIterator([msg])
    const result = await waitForInitialize(iter, undefined, 5000)
    expect(result.mode).toBe('any-output')
  })

  it('should collect early messages', async () => {
    const hookMsg = JSON.stringify({ type: 'system', subtype: 'hook_started' })
    const iter = makeIterator([hookMsg])
    const result = await waitForInitialize(iter, undefined, 5000)
    expect(result.earlyMessages).toHaveLength(1)
    expect(JSON.parse(result.earlyMessages[0]).subtype).toBe('hook_started')
  })

  it('should timeout if no output', async () => {
    const iter: AsyncIterator<string> = {
      next: () => new Promise<IteratorResult<string>>(() => {}),
    }
    await expect(waitForInitialize(iter, undefined, 200)).rejects.toThrow(InitializeTimeoutError)
  })

  it('should handle stream end before output', async () => {
    const iter = makeIterator([])
    await expect(waitForInitialize(iter, undefined, 5000)).rejects.toThrow('Claude process exited')
  })

  it('should skip empty lines', async () => {
    const initMsg = JSON.stringify({ type: 'system', subtype: 'init' })
    const iter = makeIterator(['', '  ', initMsg])
    const result = await waitForInitialize(iter, undefined, 5000)
    expect(result.mode).toBe('system-init')
  })

  it('should handle malformed JSON as any-output', async () => {
    const iter = makeIterator(['not json at all'])
    const result = await waitForInitialize(iter, undefined, 5000)
    expect(result.mode).toBe('any-output')
  })

  it('should not close the iterator after resolving', async () => {
    const initMsg = JSON.stringify({ type: 'system', subtype: 'hook_started' })
    const postMsg = JSON.stringify({ type: 'assistant', message: {} })
    const iter = makeIterator([initMsg, postMsg])
    await waitForInitialize(iter, undefined, 5000)
    const next = await iter.next()
    expect(next.done).toBe(false)
  })
})
