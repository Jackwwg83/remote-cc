// T-22: File viewer with syntax highlighting and line numbers
// Renders highlighted code as a single <pre> block (never splitting highlighted HTML
// by \n) to avoid breaking multiline <span> tags produced by highlight.js.
// Line numbers are rendered in a separate gutter column.

import { useState, useMemo, useCallback } from 'react'
import hljs from 'highlight.js'

// Extension -> highlight.js language mapping
const EXT_LANG_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  json: 'json',
  md: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  sql: 'sql',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  lua: 'lua',
  r: 'r',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
}

const COLLAPSED_LINE_THRESHOLD = 20

/** Extract language from a file path's extension */
function detectLanguage(filePath: string): string {
  const basename = filePath.split('/').pop() ?? ''
  // Handle special filenames like Dockerfile, Makefile
  const lowerBase = basename.toLowerCase()
  if (lowerBase === 'dockerfile') return 'dockerfile'
  if (lowerBase === 'makefile') return 'makefile'

  const ext = basename.split('.').pop()?.toLowerCase() ?? ''
  return EXT_LANG_MAP[ext] ?? 'plaintext'
}

/** Strip leading line number prefixes from Read tool output (e.g., "  1\tcode here") */
function stripLineNumberPrefix(text: string): { lines: string[]; hasLineNums: boolean; startLine: number } {
  const rawLines = text.split('\n')
  // Check if lines match the pattern: optional whitespace + number + tab
  const lineNumPattern = /^\s*(\d+)\t(.*)$/
  const firstMatch = rawLines[0]?.match(lineNumPattern)

  if (!firstMatch) {
    return { lines: rawLines, hasLineNums: false, startLine: 1 }
  }

  // Verify first few lines all match the pattern
  const sampleSize = Math.min(rawLines.length, 5)
  let allMatch = true
  for (let i = 0; i < sampleSize; i++) {
    if (rawLines[i].trim() === '') continue // skip blank lines
    if (!lineNumPattern.test(rawLines[i])) {
      allMatch = false
      break
    }
  }

  if (!allMatch) {
    return { lines: rawLines, hasLineNums: false, startLine: 1 }
  }

  const startLine = parseInt(firstMatch[1], 10)
  const stripped = rawLines.map((line) => {
    const m = line.match(lineNumPattern)
    return m ? m[2] : line
  })

  return { lines: stripped, hasLineNums: true, startLine }
}

interface FileViewerProps {
  content: string
  filePath: string
}

export default function FileViewer({ content, filePath }: FileViewerProps) {
  const language = useMemo(() => detectLanguage(filePath), [filePath])
  const { lines, startLine } = useMemo(() => stripLineNumberPrefix(content), [content])
  const totalLines = lines.length

  const defaultCollapsed = totalLines > COLLAPSED_LINE_THRESHOLD
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const [copied, setCopied] = useState(false)

  const visibleLines = collapsed ? lines.slice(0, COLLAPSED_LINE_THRESHOLD) : lines
  const visibleLineCount = visibleLines.length

  // Highlight the visible code as a single block — never split the result by \n.
  // highlight.js may produce multiline <span> tags that would break if split.
  const highlighted = useMemo(() => {
    const code = visibleLines.join('\n')
    if (language !== 'plaintext' && hljs.getLanguage(language)) {
      try {
        return hljs.highlight(code, { language }).value
      } catch {
        // Fall through to auto
      }
    }
    return hljs.highlightAuto(code).value
  }, [visibleLines, language])

  // Build the line number gutter as plain text (one number per line)
  const gutterText = useMemo(() => {
    return Array.from({ length: visibleLineCount }, (_, i) => startLine + i).join('\n')
  }, [visibleLineCount, startLine])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(lines.join('\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [lines])

  const fileName = filePath.split('/').pop() ?? filePath

  return (
    <div className="bg-gray-900 rounded-lg my-2 border border-gray-700/50 overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-800 border-b border-gray-700/50">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-gray-400 font-mono truncate" title={filePath}>
            {fileName}
          </span>
          <span className="text-xs text-gray-600">{language}</span>
        </div>
        <button
          onClick={handleCopy}
          className="text-xs text-gray-500 hover:text-gray-300 cursor-pointer shrink-0 ml-2"
          title="Copy file content"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>

      {/* Code with line number gutter — two synchronized <pre> blocks side by side */}
      <div className="overflow-x-auto flex">
        {/* Line number gutter */}
        <pre
          className="text-xs font-mono leading-5 py-1 px-3 m-0 bg-transparent text-gray-600 text-right select-none shrink-0 border-r border-gray-700/30"
          aria-hidden="true"
        >
          {gutterText}
        </pre>
        {/* Code block — rendered as a single highlighted <pre>, no line splitting */}
        <pre className="text-xs font-mono leading-5 py-1 px-3 m-0 bg-transparent flex-1 min-w-0">
          <code
            className="hljs"
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        </pre>
      </div>

      {/* Collapse/expand controls */}
      {defaultCollapsed && (
        <div className="px-3 py-1.5 border-t border-gray-700/30">
          {collapsed ? (
            <button
              onClick={() => setCollapsed(false)}
              className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
            >
              Show all {totalLines} lines
            </button>
          ) : (
            <button
              onClick={() => setCollapsed(true)}
              className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
            >
              Collapse
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export { detectLanguage }
