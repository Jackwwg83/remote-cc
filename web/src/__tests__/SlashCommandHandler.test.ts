/**
 * SlashCommandHandler — parse + dispatch slash commands.
 */
import { describe, it, expect } from 'vitest'
import { parseSlashCommand, sumUsage } from '../SlashCommandHandler'

describe('parseSlashCommand', () => {
  it('returns handled=false for non-slash text', () => {
    expect(parseSlashCommand('hello world').handled).toBe(false)
    expect(parseSlashCommand('').handled).toBe(false)
  })

  it('handles /clear', () => {
    const r = parseSlashCommand('/clear')
    expect(r.handled).toBe(true)
    if (r.handled) expect(r.kind).toBe('clear')
  })

  it('handles /cost', () => {
    const r = parseSlashCommand('/cost')
    expect(r.handled).toBe(true)
    if (r.handled) expect(r.kind).toBe('cost')
  })

  it('handles /compact → send_control with subtype=compact AND request_id', () => {
    const r = parseSlashCommand('/compact')
    expect(r.handled).toBe(true)
    if (r.handled && r.kind === 'send_control') {
      expect(r.controlMsg.type).toBe('control_request')
      expect((r.controlMsg.request as Record<string, unknown>).subtype).toBe('compact')
      // Contract: control_request MUST carry a request_id
      expect(typeof r.controlMsg.request_id).toBe('string')
      expect((r.controlMsg.request_id as string).length).toBeGreaterThan(0)
    }
  })

  it('handles /model <name> → set_model subtype (NOT "model") with model arg', () => {
    const r = parseSlashCommand('/model opus-4')
    expect(r.handled).toBe(true)
    if (r.handled && r.kind === 'send_control') {
      // Contract: the subtype in shared/src/types.ts is 'set_model'
      expect((r.controlMsg.request as Record<string, unknown>).subtype).toBe('set_model')
      expect((r.controlMsg.request as Record<string, unknown>).model).toBe('opus-4')
      expect(typeof r.controlMsg.request_id).toBe('string')
    }
  })

  it('handles /model with no arg → set_model subtype, no model field', () => {
    const r = parseSlashCommand('/model')
    expect(r.handled).toBe(true)
    if (r.handled && r.kind === 'send_control') {
      expect((r.controlMsg.request as Record<string, unknown>).subtype).toBe('set_model')
      expect('model' in (r.controlMsg.request as Record<string, unknown>)).toBe(false)
    }
  })

  it('each /compact call generates a unique request_id', () => {
    const r1 = parseSlashCommand('/compact')
    const r2 = parseSlashCommand('/compact')
    if (r1.handled && r1.kind === 'send_control' && r2.handled && r2.kind === 'send_control') {
      expect(r1.controlMsg.request_id).not.toBe(r2.controlMsg.request_id)
    }
  })

  it('handles /help as noop with feedback', () => {
    const r = parseSlashCommand('/help')
    expect(r.handled).toBe(true)
    if (r.handled && r.kind === 'noop') {
      expect(r.feedback).toMatch(/slash commands/i)
    }
  })

  it('unknown slash commands fall through to bridge (handled=false)', () => {
    expect(parseSlashCommand('/something-custom').handled).toBe(false)
  })

  it('is case-insensitive on command name', () => {
    expect(parseSlashCommand('/CLEAR').handled).toBe(true)
    expect(parseSlashCommand('/Clear').handled).toBe(true)
  })
})

describe('sumUsage', () => {
  it('adds input + output + cost across results', () => {
    const out = sumUsage([
      { usage: { input_tokens: 100, output_tokens: 50 }, total_cost_usd: 0.01 },
      { usage: { inputTokens: 200, outputTokens: 100 }, total_cost_usd: 0.02 },
    ])
    expect(out.inputTokens).toBe(300)
    expect(out.outputTokens).toBe(150)
    expect(out.totalCostUsd).toBeCloseTo(0.03, 5)
    expect(out.turnCount).toBe(2)
  })

  it('handles missing usage fields gracefully', () => {
    const out = sumUsage([{ total_cost_usd: 0.005 }])
    expect(out.inputTokens).toBe(0)
    expect(out.outputTokens).toBe(0)
    expect(out.totalCostUsd).toBe(0.005)
    // No usage → turnCount stays 0 (we only count turns with tokens)
    expect(out.turnCount).toBe(0)
  })
})
