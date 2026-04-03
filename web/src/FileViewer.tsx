// T-22: File viewer with syntax highlighting and line numbers

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

  const highlighted = useMemo(() => {
    const code = lines.join('\n')
    if (language !== 'plaintext' && hljs.getLanguage(language)) {
      try {
        return hljs.highlight(code, { language }).value
      } catch {
        // Fall through to plain
      }
    }
    return hljs.highlightAuto(code).value
  }, [lines, language])

  // Split highlighted HTML back into lines for line-number rendering
  const highlightedLines = useMemo(() => highlighted.split('\n'), [highlighted])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(lines.join('\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [lines])

  const visibleLines = collapsed
    ? highlightedLines.slice(0, COLLAPSED_LINE_THRESHOLD)
    : highlightedLines

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

      {/* Code with line numbers */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <tbody>
            {visibleLines.map((lineHtml, i) => (
              <tr key={i} className="hover:bg-gray-800/50">
                <td className="text-right pr-3 pl-3 py-0 select-none text-xs text-gray-600 font-mono align-top w-1 whitespace-nowrap border-r border-gray-700/30">
                  {startLine + i}
                </td>
                <td className="pl-3 pr-3 py-0">
                  <pre className="text-xs font-mono leading-5">
                    <code
                      className="hljs"
                      dangerouslySetInnerHTML={{ __html: lineHtml || '&nbsp;' }}
                    />
                  </pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
