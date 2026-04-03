// T-13: Streaming partial message state machine for remote-cc web UI

/** Content block types that accumulate during streaming */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: string; parsedInput: unknown }

export interface StreamingMessage {
  id: string
  contentBlocks: ContentBlock[]
  isStreaming: boolean
}

// --- Event shape types (loose, matching protocol) ---

interface MessageStartEvent {
  type: 'message_start'
  message: { id: string; [key: string]: unknown }
}

interface ContentBlockStartEvent {
  type: 'content_block_start'
  index: number
  content_block:
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string }
    | { type: 'tool_use'; id: string; name: string; input: string }
}

interface ContentBlockDeltaEvent {
  type: 'content_block_delta'
  index: number
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'thinking_delta'; thinking: string }
    | { type: 'input_json_delta'; partial_json: string }
}

interface ContentBlockStopEvent {
  type: 'content_block_stop'
  index: number
}

interface MessageStopEvent {
  type: 'message_stop'
}

type StreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageStopEvent

/** Check if an incoming WS message is a partial assistant message */
function isPartialMessage(data: unknown): data is { type: 'assistant'; subtype: 'partial'; event: StreamEvent } {
  if (typeof data !== 'object' || data === null) return false
  const d = data as Record<string, unknown>
  return d.type === 'assistant' && d.subtype === 'partial' && typeof d.event === 'object' && d.event !== null
}

export function createStreamingState() {
  let current: StreamingMessage | null = null

  function handlePartial(data: unknown): StreamingMessage | null {
    if (!isPartialMessage(data)) return null

    const event = data.event

    switch (event.type) {
      case 'message_start': {
        current = {
          id: event.message.id ?? '',
          contentBlocks: [],
          isStreaming: true,
        }
        return { ...current }
      }

      case 'content_block_start': {
        if (!current) return null
        const block = event.content_block
        let contentBlock: ContentBlock
        switch (block.type) {
          case 'text':
            contentBlock = { type: 'text', text: block.text ?? '' }
            break
          case 'thinking':
            contentBlock = { type: 'thinking', thinking: block.thinking ?? '' }
            break
          case 'tool_use':
            contentBlock = {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input ?? '',
              parsedInput: null,
            }
            break
          default:
            return { ...current, contentBlocks: [...current.contentBlocks] }
        }
        // Place block at the correct index
        const blocks = [...current.contentBlocks]
        blocks[event.index] = contentBlock
        current = { ...current, contentBlocks: blocks }
        return { ...current }
      }

      case 'content_block_delta': {
        if (!current) return null
        const block = current.contentBlocks[event.index]
        if (!block) return { ...current, contentBlocks: [...current.contentBlocks] }

        const blocks = [...current.contentBlocks]
        const delta = event.delta

        if (delta.type === 'text_delta' && block.type === 'text') {
          blocks[event.index] = { ...block, text: block.text + delta.text }
        } else if (delta.type === 'thinking_delta' && block.type === 'thinking') {
          blocks[event.index] = { ...block, thinking: block.thinking + delta.thinking }
        } else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
          blocks[event.index] = { ...block, input: block.input + delta.partial_json }
        }

        current = { ...current, contentBlocks: blocks }
        return { ...current }
      }

      case 'content_block_stop': {
        if (!current) return null
        const block = current.contentBlocks[event.index]
        if (block && block.type === 'tool_use') {
          // Try parsing accumulated JSON
          const blocks = [...current.contentBlocks]
          let parsed: unknown = null
          try {
            parsed = JSON.parse(block.input)
          } catch {
            // Leave as null — incomplete JSON
          }
          blocks[event.index] = { ...block, parsedInput: parsed }
          current = { ...current, contentBlocks: blocks }
        }
        return current ? { ...current, contentBlocks: [...current.contentBlocks] } : null
      }

      case 'message_stop': {
        // Handled by finalize()
        return current ? { ...current, contentBlocks: [...current.contentBlocks] } : null
      }

      default:
        return null
    }
  }

  function finalize(): StreamingMessage | null {
    if (!current) return null
    const final = { ...current, isStreaming: false, contentBlocks: [...current.contentBlocks] }
    current = null
    return final
  }

  function reset(): void {
    current = null
  }

  return { handlePartial, finalize, reset }
}

/**
 * Convert a StreamingMessage's contentBlocks into the content array format
 * that MessageRenderer expects (matching the protocol's assistant message format).
 */
export function streamingToContent(msg: StreamingMessage): unknown[] {
  return msg.contentBlocks.map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text }
      case 'thinking':
        return { type: 'thinking', thinking: block.thinking }
      case 'tool_use':
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.parsedInput ?? block.input,
        }
    }
  })
}
