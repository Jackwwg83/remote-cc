// T-13: Tests for streaming partial message state machine

import { describe, it, expect, beforeEach } from 'vitest'
import { createStreamingState, streamingToContent, type StreamingMessage } from '../streamingState'

function partial(event: unknown) {
  return { type: 'assistant', subtype: 'partial', event }
}

describe('createStreamingState', () => {
  let ss: ReturnType<typeof createStreamingState>

  beforeEach(() => {
    ss = createStreamingState()
  })

  it('returns null for non-partial messages', () => {
    expect(ss.handlePartial({ type: 'assistant', message: {} })).toBeNull()
    expect(ss.handlePartial({ type: 'system' })).toBeNull()
    expect(ss.handlePartial(null)).toBeNull()
    expect(ss.handlePartial('string')).toBeNull()
  })

  it('handles message_start', () => {
    const result = ss.handlePartial(partial({
      type: 'message_start',
      message: { id: 'msg_001' },
    }))
    expect(result).not.toBeNull()
    expect(result!.id).toBe('msg_001')
    expect(result!.contentBlocks).toEqual([])
    expect(result!.isStreaming).toBe(true)
  })

  it('handles text content block lifecycle', () => {
    // Start message
    ss.handlePartial(partial({
      type: 'message_start',
      message: { id: 'msg_001' },
    }))

    // Start text block
    const afterStart = ss.handlePartial(partial({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }))
    expect(afterStart!.contentBlocks).toHaveLength(1)
    expect(afterStart!.contentBlocks[0]).toEqual({ type: 'text', text: '' })

    // Delta
    const afterDelta1 = ss.handlePartial(partial({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    }))
    expect(afterDelta1!.contentBlocks[0]).toEqual({ type: 'text', text: 'Hello' })

    // Another delta
    const afterDelta2 = ss.handlePartial(partial({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ' world' },
    }))
    expect(afterDelta2!.contentBlocks[0]).toEqual({ type: 'text', text: 'Hello world' })

    // Stop block
    const afterStop = ss.handlePartial(partial({
      type: 'content_block_stop',
      index: 0,
    }))
    expect(afterStop!.contentBlocks[0]).toEqual({ type: 'text', text: 'Hello world' })
  })

  it('handles thinking content block', () => {
    ss.handlePartial(partial({
      type: 'message_start',
      message: { id: 'msg_002' },
    }))

    ss.handlePartial(partial({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    }))

    const result = ss.handlePartial(partial({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'let me think...' },
    }))
    expect(result!.contentBlocks[0]).toEqual({ type: 'thinking', thinking: 'let me think...' })
  })

  it('handles tool_use content block with JSON parsing', () => {
    ss.handlePartial(partial({
      type: 'message_start',
      message: { id: 'msg_003' },
    }))

    ss.handlePartial(partial({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu_001', name: 'Bash', input: '' },
    }))

    ss.handlePartial(partial({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"command":' },
    }))

    ss.handlePartial(partial({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '"ls -la"}' },
    }))

    // On block stop, input should be parsed
    const result = ss.handlePartial(partial({
      type: 'content_block_stop',
      index: 0,
    }))

    const block = result!.contentBlocks[0]
    expect(block.type).toBe('tool_use')
    if (block.type === 'tool_use') {
      expect(block.parsedInput).toEqual({ command: 'ls -la' })
      expect(block.input).toBe('{"command":"ls -la"}')
    }
  })

  it('handles tool_use with invalid JSON gracefully', () => {
    ss.handlePartial(partial({
      type: 'message_start',
      message: { id: 'msg_004' },
    }))

    ss.handlePartial(partial({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu_002', name: 'Read', input: '' },
    }))

    ss.handlePartial(partial({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"incomplete":' },
    }))

    // Stop with incomplete JSON
    const result = ss.handlePartial(partial({
      type: 'content_block_stop',
      index: 0,
    }))

    const block = result!.contentBlocks[0]
    if (block.type === 'tool_use') {
      expect(block.parsedInput).toBeNull()
      expect(block.input).toBe('{"incomplete":')
    }
  })

  it('handles multiple content blocks', () => {
    ss.handlePartial(partial({
      type: 'message_start',
      message: { id: 'msg_005' },
    }))

    // Thinking block at index 0
    ss.handlePartial(partial({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    }))

    ss.handlePartial(partial({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'hmm' },
    }))

    ss.handlePartial(partial({
      type: 'content_block_stop',
      index: 0,
    }))

    // Text block at index 1
    ss.handlePartial(partial({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    }))

    const result = ss.handlePartial(partial({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'Here is my answer' },
    }))

    expect(result!.contentBlocks).toHaveLength(2)
    expect(result!.contentBlocks[0]).toEqual({ type: 'thinking', thinking: 'hmm' })
    expect(result!.contentBlocks[1]).toEqual({ type: 'text', text: 'Here is my answer' })
  })

  it('finalize() returns final message and clears state', () => {
    ss.handlePartial(partial({
      type: 'message_start',
      message: { id: 'msg_006' },
    }))

    ss.handlePartial(partial({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }))

    ss.handlePartial(partial({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Done' },
    }))

    const final = ss.finalize()
    expect(final).not.toBeNull()
    expect(final!.id).toBe('msg_006')
    expect(final!.isStreaming).toBe(false)
    expect(final!.contentBlocks[0]).toEqual({ type: 'text', text: 'Done' })

    // State is cleared
    expect(ss.finalize()).toBeNull()
  })

  it('reset() clears state', () => {
    ss.handlePartial(partial({
      type: 'message_start',
      message: { id: 'msg_007' },
    }))

    ss.reset()
    expect(ss.finalize()).toBeNull()
  })

  it('handles delta before message_start gracefully', () => {
    const result = ss.handlePartial(partial({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'orphan' },
    }))
    expect(result).toBeNull()
  })

  it('handles delta for non-existent block index gracefully', () => {
    ss.handlePartial(partial({
      type: 'message_start',
      message: { id: 'msg_008' },
    }))

    // Delta at index 5 with no block started there
    const result = ss.handlePartial(partial({
      type: 'content_block_delta',
      index: 5,
      delta: { type: 'text_delta', text: 'orphan' },
    }))

    // Should return current state without crashing
    expect(result).not.toBeNull()
    expect(result!.contentBlocks).toHaveLength(0)
  })
})

describe('streamingToContent', () => {
  it('converts text blocks', () => {
    const msg: StreamingMessage = {
      id: 'msg_001',
      contentBlocks: [{ type: 'text', text: 'Hello' }],
      isStreaming: false,
    }
    expect(streamingToContent(msg)).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('converts thinking blocks', () => {
    const msg: StreamingMessage = {
      id: 'msg_002',
      contentBlocks: [{ type: 'thinking', thinking: 'hmm' }],
      isStreaming: false,
    }
    expect(streamingToContent(msg)).toEqual([{ type: 'thinking', thinking: 'hmm' }])
  })

  it('converts tool_use blocks with parsed input', () => {
    const msg: StreamingMessage = {
      id: 'msg_003',
      contentBlocks: [{
        type: 'tool_use',
        id: 'tu_001',
        name: 'Bash',
        input: '{"command":"ls"}',
        parsedInput: { command: 'ls' },
      }],
      isStreaming: false,
    }
    const content = streamingToContent(msg)
    expect(content).toEqual([{
      type: 'tool_use',
      id: 'tu_001',
      name: 'Bash',
      input: { command: 'ls' },
    }])
  })

  it('falls back to raw input string when parsedInput is null', () => {
    const msg: StreamingMessage = {
      id: 'msg_004',
      contentBlocks: [{
        type: 'tool_use',
        id: 'tu_002',
        name: 'Read',
        input: '{"incomplete":',
        parsedInput: null,
      }],
      isStreaming: false,
    }
    const content = streamingToContent(msg)
    expect(content[0]).toEqual({
      type: 'tool_use',
      id: 'tu_002',
      name: 'Read',
      input: '{"incomplete":',
    })
  })

  it('converts mixed blocks', () => {
    const msg: StreamingMessage = {
      id: 'msg_005',
      contentBlocks: [
        { type: 'thinking', thinking: 'let me...' },
        { type: 'text', text: 'Answer' },
        { type: 'tool_use', id: 'tu_003', name: 'Bash', input: '{}', parsedInput: {} },
      ],
      isStreaming: false,
    }
    const content = streamingToContent(msg)
    expect(content).toHaveLength(3)
    expect(content[0]).toEqual({ type: 'thinking', thinking: 'let me...' })
    expect(content[1]).toEqual({ type: 'text', text: 'Answer' })
    expect(content[2]).toEqual({ type: 'tool_use', id: 'tu_003', name: 'Bash', input: {} })
  })
})
