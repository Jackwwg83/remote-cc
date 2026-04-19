/**
 * ProgressIndicator.tsx — In-flight tool execution indicator.
 *
 * Claude Code emits tool_progress messages while long-running tools (Bash,
 * web fetches, etc.) are still executing. Without rendering them, the UI
 * looks frozen. We show a compact "⏳ Running {tool}... {elapsed}s" row
 * that auto-hides when the matching tool_result arrives.
 *
 * Shape of tool_progress (from Claude Code):
 *   { type: "tool_progress", tool_use_id, tool_name, elapsed_time_seconds }
 */

interface ProgressIndicatorProps {
  toolName: string
  elapsedSeconds: number
}

export default function ProgressIndicator({ toolName, elapsedSeconds }: ProgressIndicatorProps) {
  const friendly = toolName === 'Bash' ? 'Running Bash' : `Running ${toolName}`
  // Show seconds for the first minute, then m s
  const displayTime = elapsedSeconds < 60
    ? `${Math.floor(elapsedSeconds)}s`
    : `${Math.floor(elapsedSeconds / 60)}m ${Math.floor(elapsedSeconds % 60)}s`
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 my-2 px-3 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700/50"
    >
      <span className="inline-block animate-pulse" aria-hidden>⏳</span>
      <span className="font-mono">{friendly}...</span>
      <span className="ml-auto tabular-nums">{displayTime}</span>
    </div>
  )
}
