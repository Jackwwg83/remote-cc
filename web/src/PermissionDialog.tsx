// T-19/T-20/T-21: Permission approval dialog for remote-cc web UI

import { useMemo } from 'react'

// --- T-21: Dangerous command detection ---

const DANGEROUS_PATTERNS = [
  /\brm\b/,
  /\brmdir\b/,
  /\bdrop\b/i,
  /\bdelete\b/i,
  /\btruncate\b/i,
  /\bforce\b/i,
  /--force\b/,
  /\B-f\b/,
  /\breset\s+--hard\b/,
  /\bpush\s+--force\b/,
  /\bpush\s+-f\b/,
]

function isDangerous(text: string): boolean {
  return DANGEROUS_PATTERNS.some((re) => re.test(text))
}

// --- Types ---

export interface PermissionRequest {
  type: 'control_request'
  request_id: string
  request: {
    subtype: 'can_use_tool'
    tool_name: string
    tool_use_id: string
    input: Record<string, unknown>
    title: string
    display_name: string
    description: string
  }
}

export interface PermissionAction {
  requestId: string
  behavior: 'allow' | 'deny'
}

// --- Input display logic ---

function formatInput(toolName: string, input: Record<string, unknown>): {
  label: string
  code: string
} {
  // Bash: show command as code
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return { label: 'Command', code: input.command }
  }

  // FileEdit / FileWrite / Write / Edit: show file path
  if (
    ['FileEdit', 'FileWrite', 'Write', 'Edit'].includes(toolName) &&
    typeof input.file_path === 'string'
  ) {
    return { label: 'File', code: input.file_path }
  }

  // Fallback: JSON
  return { label: 'Input', code: JSON.stringify(input, null, 2) }
}

// --- Component ---

interface Props {
  request: PermissionRequest
  onRespond: (action: PermissionAction) => void
}

export default function PermissionDialog({ request, onRespond }: Props) {
  const { request_id, request: req } = request
  const { label, code } = useMemo(
    () => formatInput(req.tool_name, req.input),
    [req.tool_name, req.input],
  )
  const dangerous = useMemo(() => isDangerous(code), [code])

  return (
    // Full-screen overlay
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl bg-gray-800 shadow-2xl border border-gray-700">
        {/* Header */}
        <div className="px-5 pt-5 pb-3">
          <h2 className="text-lg font-semibold text-yellow-300 flex items-center gap-2">
            <span className="text-xl">&#9888;&#65039;</span>
            Permission Required
          </h2>
        </div>

        {/* Body */}
        <div className="px-5 pb-4 space-y-3">
          <p className="text-sm text-gray-300">
            <span className="font-mono font-medium text-white">{req.display_name}</span>
            {' '}wants to execute:
          </p>

          {/* T-21: Dangerous highlight + warning label */}
          {dangerous && (
            <div className="flex items-center gap-2 text-red-400 text-xs font-medium">
              <span>&#9888;&#65039;</span>
              <span>Potentially destructive</span>
            </div>
          )}

          {/* Code block */}
          <div
            className={`rounded-lg p-3 text-sm font-mono whitespace-pre-wrap break-words overflow-x-auto
              bg-gray-900 ${dangerous ? 'border-2 border-red-500/70' : 'border border-gray-700'}`}
          >
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">{label}</div>
            <div className="text-gray-200">{code}</div>
          </div>
        </div>

        {/* Action buttons — T-20 */}
        <div className="px-5 pb-5 flex gap-3">
          <button
            onClick={() => onRespond({ requestId: request_id, behavior: 'allow' })}
            className="flex-1 min-h-[48px] rounded-lg bg-green-600 text-white font-semibold text-base
              hover:bg-green-500 active:bg-green-700 transition-colors
              focus:outline-none focus:ring-2 focus:ring-green-400"
          >
            Allow
          </button>
          <button
            onClick={() => onRespond({ requestId: request_id, behavior: 'deny' })}
            className="flex-1 min-h-[48px] rounded-lg bg-red-600 text-white font-semibold text-base
              hover:bg-red-500 active:bg-red-700 transition-colors
              focus:outline-none focus:ring-2 focus:ring-red-400"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  )
}
