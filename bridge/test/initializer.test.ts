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

function makeDelayedIterator(lines: Array<{ line: string; delayMs: number }>): AsyncIterator<string> {
  let i = 0
  return {
    async next() {
      if (i < lines.length) {
        const { line, delayMs } = lines[i++]
        await new Promise(r => setTimeout(r, delayMs))
        return { value: line, done: false }
      }
      return { value: undefined as unknown as string, done: true }
    },
  }
}

describe('waitForInitialize', () => {
  it('should resolve on system.init message', async () => {
    const initMsg = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test-123', tools: ['Bash'] })
    const iter = makeIterator([initMsg])
    const result = await waitForInitialize(iter, undefined, 5000)
    expect(result.initMessage).toEqual({ type: 'system', subtype: 'init', session_id: 'test-123', tools: ['Bash'] })
    expect(result.preInitMessages).toEqual([])
  })

  it('should collect pre-init messages', async () => {
    const hookMsg = JSON.stringify({ type: 'system', subtype: 'hook_started', hook_id: 'h1' })
    const initMsg = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test-123' })
    const iter = makeIterator([hookMsg, initMsg])
    const result = await waitForInitialize(iter, undefined, 5000)
    expect(result.preInitMessages).toHaveLength(1)
    expect(JSON.parse(result.preInitMessages[0]).subtype).toBe('hook_started')
  })

  it('should timeout if no init message', async () => {
    const iter: AsyncIterator<string> = {
      next: () => new Promise<IteratorResult<string>>(() => {}),
    }
    await expect(waitForInitialize(iter, undefined, 200)).rejects.toThrow(InitializeTimeoutError)
  })

  it('should handle stream end before init', async () => {
    const iter = makeIterator([])
    await expect(waitForInitialize(iter, undefined, 5000)).rejects.toThrow('Stream ended')
  })

  it('should skip malformed JSON', async () => {
    const initMsg = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'ok' })
    const iter = makeIterator(['not json', '', initMsg])
    const result = await waitForInitialize(iter, undefined, 5000)
    expect(result.initMessage.session_id).toBe('ok')
  })

  it('should skip empty lines', async () => {
    const initMsg = JSON.stringify({ type: 'system', subtype: 'init' })
    const iter = makeIterator(['', '  ', initMsg])
    const result = await waitForInitialize(iter, undefined, 5000)
    expect(result.initMessage.type).toBe('system')
  })

  it('should not close the iterator after resolving', async () => {
    const initMsg = JSON.stringify({ type: 'system', subtype: 'init' })
    const postMsg = JSON.stringify({ type: 'assistant', message: { content: 'hi' } })
    const iter = makeIterator([initMsg, postMsg])
    await waitForInitialize(iter, undefined, 5000)
    // Iterator should still be usable
    const next = await iter.next()
    expect(next.done).toBe(false)
    expect(JSON.parse(next.value).type).toBe('assistant')
  })

  it('should also accept control_request initialize (SDK mode)', async () => {
    const writeToStdin = vi.fn()
    const initMsg = JSON.stringify({
      type: 'control_request',
      request_id: 'req_1',
      request: { subtype: 'initialize' }
    })
    const iter = makeIterator([initMsg])
    const result = await waitForInitialize(iter, writeToStdin, 5000)
    expect(result.initMessage.type).toBe('control_request')
    // Should have sent response
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

  it('should handle delayed init arrival', async () => {
    const initMsg = JSON.stringify({ type: 'system', subtype: 'init' })
    const iter = makeDelayedIterator([
      { line: JSON.stringify({ type: 'system', subtype: 'hook_response' }), delayMs: 50 },
      { line: initMsg, delayMs: 100 },
    ])
    const result = await waitForInitialize(iter, undefined, 5000)
    expect(result.initMessage.subtype).toBe('init')
    expect(result.preInitMessages).toHaveLength(1)
  })
})
