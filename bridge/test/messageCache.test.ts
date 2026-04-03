/**
 * Tests for messageCache.ts — ring buffer message cache
 *
 * Strategy:
 * - Test basic push/replay/currentSeq operations
 * - Test ring buffer overflow (eviction of oldest messages)
 * - Test replay with various fromSeq values
 * - Test edge cases: empty cache, replay beyond capacity, exact boundary
 */

import { describe, it, expect } from 'vitest'
import { createMessageCache } from '../src/messageCache.js'

describe('createMessageCache', () => {
  // -------------------------------------------------------------------------
  // Basic operations
  // -------------------------------------------------------------------------

  it('should start with currentSeq 0', () => {
    const cache = createMessageCache()
    expect(cache.currentSeq()).toBe(0)
  })

  it('should return empty array when replaying from empty cache', () => {
    const cache = createMessageCache()
    expect(cache.replay(0)).toEqual([])
  })

  it('should store and replay a single message', () => {
    const cache = createMessageCache()
    cache.push('msg-1', 1)

    expect(cache.currentSeq()).toBe(1)
    expect(cache.replay(0)).toEqual(['msg-1'])
  })

  it('should store and replay multiple messages in order', () => {
    const cache = createMessageCache()
    cache.push('msg-1', 1)
    cache.push('msg-2', 2)
    cache.push('msg-3', 3)

    expect(cache.currentSeq()).toBe(3)
    expect(cache.replay(0)).toEqual(['msg-1', 'msg-2', 'msg-3'])
  })

  // -------------------------------------------------------------------------
  // Replay from specific sequence
  // -------------------------------------------------------------------------

  it('should replay only messages after fromSeq', () => {
    const cache = createMessageCache()
    cache.push('msg-1', 1)
    cache.push('msg-2', 2)
    cache.push('msg-3', 3)
    cache.push('msg-4', 4)
    cache.push('msg-5', 5)

    expect(cache.replay(3)).toEqual(['msg-4', 'msg-5'])
  })

  it('should return empty array when fromSeq equals currentSeq', () => {
    const cache = createMessageCache()
    cache.push('msg-1', 1)
    cache.push('msg-2', 2)

    expect(cache.replay(2)).toEqual([])
  })

  it('should return empty array when fromSeq is beyond currentSeq', () => {
    const cache = createMessageCache()
    cache.push('msg-1', 1)

    expect(cache.replay(5)).toEqual([])
  })

  it('should replay all messages when fromSeq is 0', () => {
    const cache = createMessageCache()
    cache.push('a', 1)
    cache.push('b', 2)
    cache.push('c', 3)

    expect(cache.replay(0)).toEqual(['a', 'b', 'c'])
  })

  // -------------------------------------------------------------------------
  // Ring buffer overflow
  // -------------------------------------------------------------------------

  it('should evict oldest messages when buffer is full', () => {
    const cache = createMessageCache(3) // tiny buffer
    cache.push('msg-1', 1)
    cache.push('msg-2', 2)
    cache.push('msg-3', 3)
    cache.push('msg-4', 4) // evicts msg-1

    expect(cache.currentSeq()).toBe(4)
    // msg-1 is gone
    expect(cache.replay(0)).toEqual(['msg-2', 'msg-3', 'msg-4'])
  })

  it('should handle multiple overflow cycles', () => {
    const cache = createMessageCache(3)

    // Fill: [1, 2, 3]
    cache.push('msg-1', 1)
    cache.push('msg-2', 2)
    cache.push('msg-3', 3)

    // Overflow once: [4, 2, 3] → [4, 5, 3] → [4, 5, 6]
    cache.push('msg-4', 4)
    cache.push('msg-5', 5)
    cache.push('msg-6', 6)

    expect(cache.replay(0)).toEqual(['msg-4', 'msg-5', 'msg-6'])
    expect(cache.replay(4)).toEqual(['msg-5', 'msg-6'])
    expect(cache.replay(5)).toEqual(['msg-6'])
    expect(cache.replay(6)).toEqual([])
  })

  it('should handle replay request for evicted messages gracefully', () => {
    const cache = createMessageCache(3)
    cache.push('msg-1', 1)
    cache.push('msg-2', 2)
    cache.push('msg-3', 3)
    cache.push('msg-4', 4) // evicts msg-1
    cache.push('msg-5', 5) // evicts msg-2

    // Asking for seq 1 — msg-1 and msg-2 are evicted, only msg-3+ remain
    expect(cache.replay(1)).toEqual(['msg-3', 'msg-4', 'msg-5'])
  })

  // -------------------------------------------------------------------------
  // Buffer size 1
  // -------------------------------------------------------------------------

  it('should work with buffer size 1', () => {
    const cache = createMessageCache(1)
    cache.push('msg-1', 1)
    expect(cache.replay(0)).toEqual(['msg-1'])

    cache.push('msg-2', 2)
    expect(cache.replay(0)).toEqual(['msg-2'])
    expect(cache.replay(1)).toEqual(['msg-2'])
    expect(cache.replay(2)).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Default buffer size
  // -------------------------------------------------------------------------

  it('should default to 200 message capacity', () => {
    const cache = createMessageCache() // default 200

    // Fill 250 messages
    for (let i = 1; i <= 250; i++) {
      cache.push(`msg-${i}`, i)
    }

    expect(cache.currentSeq()).toBe(250)

    // Only the last 200 should be available
    const all = cache.replay(0)
    expect(all.length).toBe(200)
    expect(all[0]).toBe('msg-51')  // first surviving message
    expect(all[199]).toBe('msg-250') // last message
  })

  // -------------------------------------------------------------------------
  // Sequence number tracking
  // -------------------------------------------------------------------------

  it('should track the latest sequence number', () => {
    const cache = createMessageCache()
    expect(cache.currentSeq()).toBe(0)

    cache.push('a', 10)
    expect(cache.currentSeq()).toBe(10)

    cache.push('b', 20)
    expect(cache.currentSeq()).toBe(20)

    cache.push('c', 30)
    expect(cache.currentSeq()).toBe(30)
  })

  // -------------------------------------------------------------------------
  // Non-sequential sequence numbers
  // -------------------------------------------------------------------------

  it('should handle gaps in sequence numbers', () => {
    const cache = createMessageCache()
    cache.push('msg-1', 1)
    cache.push('msg-5', 5)  // gap: 2,3,4 skipped
    cache.push('msg-10', 10)

    expect(cache.replay(0)).toEqual(['msg-1', 'msg-5', 'msg-10'])
    expect(cache.replay(1)).toEqual(['msg-5', 'msg-10'])
    expect(cache.replay(5)).toEqual(['msg-10'])
    expect(cache.replay(3)).toEqual(['msg-5', 'msg-10'])
  })

  // -------------------------------------------------------------------------
  // JSON-like messages (realistic usage)
  // -------------------------------------------------------------------------

  it('should handle JSON string messages correctly', () => {
    const cache = createMessageCache()

    const msg1 = JSON.stringify({ type: 'assistant', content: 'hello' })
    const msg2 = JSON.stringify({ type: 'control_request', request_id: '001' })
    const msg3 = JSON.stringify({ type: 'result', content: 'done' })

    cache.push(msg1, 1)
    cache.push(msg2, 2)
    cache.push(msg3, 3)

    const replayed = cache.replay(1)
    expect(replayed).toHaveLength(2)
    expect(JSON.parse(replayed[0])).toEqual({ type: 'control_request', request_id: '001' })
    expect(JSON.parse(replayed[1])).toEqual({ type: 'result', content: 'done' })
  })
})
