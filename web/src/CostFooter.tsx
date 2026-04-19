/**
 * CostFooter.tsx — Per-turn token count + cost display.
 *
 * Renders a compact summary line after each result message:
 *   "1.2k in · 345 out · $0.0021 · 2.5s"
 *
 * Inputs come from the `result` message Claude emits at the end of each
 * turn:
 *   { type: "result", usage: { inputTokens, outputTokens, cache_*_tokens? },
 *     total_cost_usd, duration_ms }
 *
 * Some SDK variants use different field names (input_tokens vs inputTokens,
 * etc.) — we coalesce both.
 */

export interface UsageLike {
  inputTokens?: number
  input_tokens?: number
  outputTokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface CostFooterProps {
  usage?: UsageLike
  totalCostUsd?: number
  durationMs?: number
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

function formatCost(usd: number): string {
  if (usd < 0.001) return `$${usd.toFixed(5)}`
  if (usd < 1) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}

export default function CostFooter({ usage, totalCostUsd, durationMs }: CostFooterProps) {
  const inTok = usage?.inputTokens ?? usage?.input_tokens ?? 0
  const outTok = usage?.outputTokens ?? usage?.output_tokens ?? 0
  const cacheRead = usage?.cache_read_input_tokens ?? 0
  const cacheCreate = usage?.cache_creation_input_tokens ?? 0

  // Don't render anything if there's no meaningful data
  if (inTok === 0 && outTok === 0 && !totalCostUsd && !durationMs) return null

  const parts: Array<{ key: string; text: string; title?: string }> = []
  if (inTok > 0) parts.push({ key: 'in', text: `${formatTokens(inTok)} in`, title: `${inTok} input tokens` })
  if (outTok > 0) parts.push({ key: 'out', text: `${formatTokens(outTok)} out`, title: `${outTok} output tokens` })
  if (cacheRead > 0 || cacheCreate > 0) {
    parts.push({
      key: 'cache',
      text: `${formatTokens(cacheRead + cacheCreate)} cache`,
      title: `${cacheRead} read + ${cacheCreate} created`,
    })
  }
  if (typeof totalCostUsd === 'number' && totalCostUsd > 0) {
    parts.push({ key: 'cost', text: formatCost(totalCostUsd) })
  }
  if (typeof durationMs === 'number' && durationMs > 0) {
    parts.push({ key: 'dur', text: formatDuration(durationMs) })
  }

  return (
    <div className="text-[11px] text-gray-400 dark:text-gray-500 font-mono flex flex-wrap gap-x-2 gap-y-0.5 px-1 py-1 my-1 select-none">
      {parts.map((p, i) => (
        <span key={p.key} title={p.title}>
          {p.text}
          {i < parts.length - 1 && <span className="text-gray-300 dark:text-gray-600 ml-2">·</span>}
        </span>
      ))}
    </div>
  )
}
