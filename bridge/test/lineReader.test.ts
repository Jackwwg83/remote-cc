/**
 * Tests for lineReader.ts
 *
 * Strategy:
 * - Use PassThrough streams to simulate claude stdout/stdin with full control
 *   over chunk boundaries and timing.
 * - Test: complete lines, cross-chunk lines, multi-line chunks, empty lines,
 *   stream-end residual buffer, writeLine serialization.
 */

import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { createLineReader, writeLine } from '../src/lineReader.js'

// Helper: collect all lines from a line reader into an array
async function collectLines(stream: PassThrough): Promise<string[]> {
  const lines: string[] = []
  for await (const line of createLineReader(stream)) {
    lines.push(line)
  }
  return lines
}

// Helper: push chunks to a stream with optional delays between them
function pushChunks(stream: PassThrough, chunks: string[], endAfter = true): void {
  for (const chunk of chunks) {
    stream.push(chunk)
  }
  if (endAfter) {
    stream.push(null) // signal end
  }
}

describe('createLineReader', () => {
  it('should yield a single complete line', async () => {
    const stream = new PassThrough()
    pushChunks(stream, ['hello\n'])

    const lines = await collectLines(stream)
    expect(lines).toEqual(['hello'])
  })

  it('should yield multiple complete lines from a single chunk', async () => {
    const stream = new PassThrough()
    pushChunks(stream, ['line1\nline2\nline3\n'])

    const lines = await collectLines(stream)
    expect(lines).toEqual(['line1', 'line2', 'line3'])
  })

  it('should reassemble a line split across multiple chunks', async () => {
    const stream = new PassThrough()
    // "hello world\n" split into 3 chunks
    pushChunks(stream, ['hel', 'lo wor', 'ld\n'])

    const lines = await collectLines(stream)
    expect(lines).toEqual(['hello world'])
  })

  it('should handle a mix of complete and partial lines across chunks', async () => {
    const stream = new PassThrough()
    // chunk 1: complete line + start of next
    // chunk 2: rest of line + another complete line
    pushChunks(stream, ['first\nsec', 'ond\nthird\n'])

    const lines = await collectLines(stream)
    expect(lines).toEqual(['first', 'second', 'third'])
  })

  it('should yield empty lines', async () => {
    const stream = new PassThrough()
    // Two newlines in a row = one empty line between them
    pushChunks(stream, ['\n\nfoo\n\n'])

    const lines = await collectLines(stream)
    expect(lines).toEqual(['', '', 'foo', ''])
  })

  it('should yield residual buffer content when stream ends without trailing newline', async () => {
    const stream = new PassThrough()
    pushChunks(stream, ['complete\nno-newline-at-end'])

    const lines = await collectLines(stream)
    expect(lines).toEqual(['complete', 'no-newline-at-end'])
  })

  it('should yield nothing for an empty stream', async () => {
    const stream = new PassThrough()
    pushChunks(stream, [])

    const lines = await collectLines(stream)
    expect(lines).toEqual([])
  })

  it('should handle Buffer chunks (not just strings)', async () => {
    const stream = new PassThrough()
    stream.push(Buffer.from('buf line\n'))
    stream.push(null)

    const lines = await collectLines(stream)
    expect(lines).toEqual(['buf line'])
  })

  it('should handle JSON lines (the real use case)', async () => {
    const msg1 = JSON.stringify({ type: 'assistant', message: { content: 'hello' } })
    const msg2 = JSON.stringify({ type: 'result', result: 42 })

    const stream = new PassThrough()
    // Simulate chunked arrival: msg1 split across chunks, msg2 in one chunk
    const half = Math.floor(msg1.length / 2)
    pushChunks(stream, [
      msg1.slice(0, half),
      msg1.slice(half) + '\n' + msg2 + '\n',
    ])

    const lines = await collectLines(stream)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual({ type: 'assistant', message: { content: 'hello' } })
    expect(JSON.parse(lines[1])).toEqual({ type: 'result', result: 42 })
  })

  it('should propagate stream errors', async () => {
    const stream = new PassThrough()

    const reader = createLineReader(stream)
    const iter = reader[Symbol.asyncIterator]()

    // Push a line then error
    stream.push('good line\n')
    // Let the event loop process the data event
    await new Promise(r => setTimeout(r, 10))

    const first = await iter.next()
    expect(first.value).toBe('good line')

    // Now emit an error
    stream.destroy(new Error('stream broke'))

    await expect(iter.next()).rejects.toThrow('stream broke')
  })

  it('should handle delayed chunks arriving over time', async () => {
    const stream = new PassThrough()

    const linesPromise = collectLines(stream)

    // Simulate delayed arrivals
    stream.push('chunk1')
    await new Promise(r => setTimeout(r, 20))
    stream.push('-part2\nline')
    await new Promise(r => setTimeout(r, 20))
    stream.push('2\n')
    await new Promise(r => setTimeout(r, 20))
    stream.push(null)

    const lines = await linesPromise
    expect(lines).toEqual(['chunk1-part2', 'line2'])
  })

  it('should handle a single newline chunk', async () => {
    const stream = new PassThrough()
    pushChunks(stream, ['\n'])

    const lines = await collectLines(stream)
    expect(lines).toEqual([''])
  })

  it('should handle only residual content (no newlines at all)', async () => {
    const stream = new PassThrough()
    pushChunks(stream, ['no newlines here'])

    const lines = await collectLines(stream)
    expect(lines).toEqual(['no newlines here'])
  })

  it('should handle UTF-8 multi-byte chars split across chunk boundaries', async () => {
    const stream = new PassThrough()

    // Chinese character "你" is 3 bytes: 0xe4 0xbd 0xa0
    // "好" is 3 bytes: 0xe5 0xa5 0xbd
    // Split "你好\n" across chunks so the multi-byte char spans the boundary
    const fullBytes = Buffer.from('你好\n', 'utf8')
    // Split after byte 1 of "你" (mid-character)
    const chunk1 = fullBytes.subarray(0, 1)  // 0xe4 (incomplete char)
    const chunk2 = fullBytes.subarray(1)      // rest: 0xbd 0xa0 + "好\n"

    stream.push(chunk1)
    stream.push(chunk2)
    stream.push(null)

    const lines = await collectLines(stream)
    expect(lines).toEqual(['你好'])
  })

  it('should handle emoji (4-byte UTF-8) split across chunk boundaries', async () => {
    const stream = new PassThrough()

    // Emoji "🎉" is 4 bytes: 0xf0 0x9f 0x8e 0x89
    const fullBytes = Buffer.from('hello 🎉 world\n', 'utf8')
    // Find the emoji start and split in the middle of it
    const emojiStart = fullBytes.indexOf(0xf0)
    const chunk1 = fullBytes.subarray(0, emojiStart + 2)  // split inside emoji
    const chunk2 = fullBytes.subarray(emojiStart + 2)

    stream.push(chunk1)
    stream.push(chunk2)
    stream.push(null)

    const lines = await collectLines(stream)
    expect(lines).toEqual(['hello 🎉 world'])
  })

  it('should handle multiple multi-byte chars across multiple chunk boundaries', async () => {
    const stream = new PassThrough()

    // Build a line with various multi-byte chars
    const text = '日本語テスト\n'
    const fullBytes = Buffer.from(text, 'utf8')

    // Split into single-byte chunks to maximally stress the decoder
    for (let i = 0; i < fullBytes.length; i++) {
      stream.push(fullBytes.subarray(i, i + 1))
    }
    stream.push(null)

    const lines = await collectLines(stream)
    expect(lines).toEqual(['日本語テスト'])
  })

  it('should clean up listeners when generator is returned early', async () => {
    const stream = new PassThrough()

    const reader = createLineReader(stream)
    const iter = reader[Symbol.asyncIterator]()

    stream.push('line1\nline2\nline3\n')
    await new Promise(r => setTimeout(r, 10))

    // Read only first line then return (close the iterator)
    const first = await iter.next()
    expect(first.value).toBe('line1')

    // Close the generator — should remove listeners
    await iter.return!(undefined)

    // Verify listeners were removed (data, end, error)
    expect(stream.listenerCount('data')).toBe(0)
    expect(stream.listenerCount('end')).toBe(0)
    expect(stream.listenerCount('error')).toBe(0)

    stream.destroy()
  })
})

describe('writeLine', () => {
  it('should write JSON + newline to the stream', () => {
    const stream = new PassThrough()
    const chunks: string[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))

    writeLine(stream, { type: 'user', content: 'hello' })
    stream.end()

    const written = chunks.join('')
    expect(written).toBe('{"type":"user","content":"hello"}\n')
  })

  it('should handle primitive values', () => {
    const stream = new PassThrough()
    const chunks: string[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))

    writeLine(stream, 42)
    writeLine(stream, 'string')
    writeLine(stream, null)
    writeLine(stream, true)
    stream.end()

    const written = chunks.join('')
    expect(written).toBe('42\n"string"\nnull\ntrue\n')
  })

  it('should handle nested objects', () => {
    const stream = new PassThrough()
    const chunks: string[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))

    writeLine(stream, { a: { b: { c: [1, 2, 3] } } })
    stream.end()

    const written = chunks.join('')
    const parsed = JSON.parse(written.trim())
    expect(parsed).toEqual({ a: { b: { c: [1, 2, 3] } } })
  })

  it('should produce output parseable by createLineReader', async () => {
    // Round-trip test: writeLine → createLineReader → parse
    const stream = new PassThrough()

    const msg1 = { type: 'user', content: 'test message' }
    const msg2 = { type: 'system', content: 'system prompt' }

    writeLine(stream, msg1)
    writeLine(stream, msg2)
    stream.end()

    const lines = await collectLines(stream)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual(msg1)
    expect(JSON.parse(lines[1])).toEqual(msg2)
  })
})
