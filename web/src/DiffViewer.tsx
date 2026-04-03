// T-23: Diff viewer with diff2html inline rendering

import { useState, useMemo } from 'react'
import { html as diff2html } from 'diff2html'
import 'diff2html/bundles/css/diff2html.min.css'

const LARGE_DIFF_LINES = 50

interface DiffViewerProps {
  content: string
  filePath?: string
}

/**
 * Attempt to normalize content into a unified diff format that diff2html can parse.
 * Claude Code's FileEdit tool_result may output raw diff or a description.
 */
function normalizeDiff(content: string, filePath?: string): string {
  const trimmed = content.trim()

  // Already a unified diff (starts with --- or diff --git)
  if (trimmed.startsWith('---') || trimmed.startsWith('diff --git') || trimmed.startsWith('diff -')) {
    return trimmed
  }

  // Has diff-like hunks (@@ ... @@) but missing header — add a synthetic one
  if (trimmed.includes('@@ ') && (trimmed.includes('+') || trimmed.includes('-'))) {
    const fname = filePath ?? 'file'
    return `--- a/${fname}\n+++ b/${fname}\n${trimmed}`
  }

  // Looks like line-by-line additions/deletions (lines starting with + or -)
  const lines = trimmed.split('\n')
  const diffLikeLines = lines.filter((l) => l.startsWith('+') || l.startsWith('-'))
  if (diffLikeLines.length > 0 && diffLikeLines.length / lines.length > 0.3) {
    const fname = filePath ?? 'file'
    return `--- a/${fname}\n+++ b/${fname}\n@@ -1,1 +1,1 @@\n${trimmed}`
  }

  // Not a diff — return as-is, will fall back to plain text
  return trimmed
}

export default function DiffViewer({ content, filePath }: DiffViewerProps) {
  const normalized = useMemo(() => normalizeDiff(content, filePath), [content, filePath])
  const lineCount = content.split('\n').length

  // Large diffs default collapsed, small diffs default expanded
  const defaultCollapsed = lineCount > LARGE_DIFF_LINES
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  const diffHtml = useMemo(() => {
    try {
      return diff2html(normalized, {
        drawFileList: false,
        outputFormat: 'line-by-line',
        matching: 'lines',
        colorScheme: 'dark',
      })
    } catch {
      // If diff2html can't parse it, return null to fall back to plain text
      return null
    }
  }, [normalized])

  // Fallback: if diff2html can't parse, show as plain preformatted text
  if (!diffHtml || diffHtml.trim() === '') {
    return (
      <div className="bg-gray-800/80 rounded-lg p-3 my-2 border border-gray-700/50">
        {filePath && (
          <div className="text-xs text-gray-400 font-mono mb-2">{filePath}</div>
        )}
        <pre className="text-xs text-gray-400 whitespace-pre-wrap break-words overflow-x-auto">
          {content}
        </pre>
      </div>
    )
  }

  const fileName = filePath?.split('/').pop() ?? filePath

  return (
    <div className="rounded-lg my-2 border border-gray-700/50 overflow-hidden diff-viewer-container">
      {/* Header */}
      {fileName && (
        <div className="flex items-center px-3 py-1.5 bg-gray-800 border-b border-gray-700/50">
          <span className="text-xs text-gray-400 font-mono truncate" title={filePath}>
            {fileName}
          </span>
          <span className="text-xs text-gray-600 ml-2">diff</span>
        </div>
      )}

      {/* Collapsible diff body */}
      {collapsed ? (
        <div className="px-3 py-2 bg-gray-900">
          <button
            onClick={() => setCollapsed(false)}
            className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
          >
            Show diff ({lineCount} lines)
          </button>
        </div>
      ) : (
        <>
          <div
            className="diff-viewer-body overflow-x-auto text-xs"
            dangerouslySetInnerHTML={{ __html: diffHtml }}
          />
          {defaultCollapsed && (
            <div className="px-3 py-1.5 bg-gray-900 border-t border-gray-700/30">
              <button
                onClick={() => setCollapsed(true)}
                className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
              >
                Collapse
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
