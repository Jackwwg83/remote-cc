/**
 * SlashCommandHandler.ts — Intercept / commands before sending to bridge.
 *
 * Some commands are handled entirely client-side (/clear, /cost) while
 * others are forwarded as control_request messages so the bridge /
 * Claude CLI can process them (/model, /compact).
 *
 * Unknown / commands fall through as regular user messages, matching
 * Claude CLI's default behavior.
 */

export type SlashCommandAction =
  | { handled: false } // not a slash command, or unknown — send as regular message
  | { handled: true; kind: 'clear'; confirm?: string }
  | { handled: true; kind: 'cost' }
  | { handled: true; kind: 'send_control'; controlMsg: Record<string, unknown> }
  | { handled: true; kind: 'noop'; feedback: string }

/** Known slash commands. Anything else falls through to the bridge unchanged. */
const KNOWN = new Set(['/clear', '/cost', '/compact', '/model', '/help'])

export function parseSlashCommand(input: string): SlashCommandAction {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return { handled: false }

  const [cmdRaw, ...argsParts] = trimmed.split(/\s+/)
  const cmd = cmdRaw.toLowerCase()
  const args = argsParts.join(' ')

  if (!KNOWN.has(cmd)) {
    // Let unknown slash commands through — bridge / Claude may handle them
    return { handled: false }
  }

  switch (cmd) {
    case '/clear':
      // Client-side clear of message list; no server round-trip.
      return { handled: true, kind: 'clear', confirm: 'Conversation cleared' }

    case '/cost':
      // Client-side display — the UI will flip an overlay showing cumulative cost.
      return { handled: true, kind: 'cost' }

    case '/compact':
      return {
        handled: true,
        kind: 'send_control',
        controlMsg: {
          type: 'control_request',
          request: { subtype: 'compact' },
        },
      }

    case '/model': {
      // /model foo → request change to model foo
      // /model (no args) → request current model info
      const request: Record<string, unknown> = { subtype: 'model' }
      if (args) request.model = args
      return {
        handled: true,
        kind: 'send_control',
        controlMsg: { type: 'control_request', request },
      }
    }

    case '/help':
      return {
        handled: true,
        kind: 'noop',
        feedback: [
          'Available slash commands:',
          '  /clear    Clear the conversation view',
          '  /cost     Show cumulative token + cost usage',
          '  /compact  Ask Claude to compact the conversation',
          '  /model [name]  Query or switch model',
          '  /help     Show this list',
        ].join('\n'),
      }

    default:
      return { handled: false }
  }
}

/** Sum cost + tokens from a series of result message payloads. */
export interface CumulativeUsage {
  inputTokens: number
  outputTokens: number
  totalCostUsd: number
  turnCount: number
}

export function sumUsage(results: Array<{ usage?: { inputTokens?: number; input_tokens?: number; outputTokens?: number; output_tokens?: number }; total_cost_usd?: number }>): CumulativeUsage {
  let inTok = 0, outTok = 0, cost = 0, turns = 0
  for (const r of results) {
    const i = r.usage?.inputTokens ?? r.usage?.input_tokens ?? 0
    const o = r.usage?.outputTokens ?? r.usage?.output_tokens ?? 0
    if (i > 0 || o > 0) turns++
    inTok += i
    outTok += o
    cost += r.total_cost_usd ?? 0
  }
  return { inputTokens: inTok, outputTokens: outTok, totalCostUsd: cost, turnCount: turns }
}
