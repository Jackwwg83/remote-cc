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

  it('handles /compact → send_control with subtype=compact', () => {
    const r = parseSlashCommand('/compact')
    expect(r.handled).toBe(true)
    if (r.handled && r.kind === 'send_control') {
      expect(r.controlMsg.type).toBe('control_request')
      expect((r.controlMsg.request as Record<string, unknown>).subtype).toBe('compact')
    }
  })

  it('handles /model <name> → send_control with model arg', () => {
    const r = parseSlashCommand('/model opus-4')
    expect(r.handled).toBe(true)
    if (r.handled && r.kind === 'send_control') {
      expect((r.controlMsg.request as Record<string, unknown>).model).toBe('opus-4')
    }
  })

  it('handles /model with no arg → no model field', () => {
    const r = parseSlashCommand('/model')
    expect(r.handled).toBe(true)
    if (r.handled && r.kind === 'send_control') {
      expect('model' in (r.controlMsg.request as Record<string, unknown>)).toBe(false)
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
