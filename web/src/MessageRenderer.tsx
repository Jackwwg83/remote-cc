// T-11/T-15/T-16/T-17/T-18/T-22/T-23: Message renderer for remote-cc web UI

import { useState, useMemo, useCallback } from 'react'
import { marked } from 'marked'
import hljs from 'highlight.js'
import DOMPurify from 'dompurify'
import 'highlight.js/styles/github-dark.min.css'
import FileViewer from './FileViewer'
import DiffViewer from './DiffViewer'
import CostFooter, { type UsageLike } from './CostFooter'

// Configure marked with highlight.js for code blocks
marked.setOptions({
  gfm: true,
  breaks: true,
})

// Custom renderer for code blocks with highlight.js
const renderer = new marked.Renderer()
renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
  if (lang && hljs.getLanguage(lang)) {
    const highlighted = hljs.highlight(text, { language: lang }).value
    return `<pre><code class="hljs language-${lang}">${highlighted}</code></pre>`
  }
  const highlighted = hljs.highlightAuto(text).value
  return `<pre><code class="hljs">${highlighted}</code></pre>`
}

function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { renderer }) as string
  return DOMPurify.sanitize(raw)
}

// --- T-15: Tool call card ---

function formatToolParams(name: string, input: unknown): { display: string; isMono: boolean } {
  const params = input as Record<string, unknown> | null
  if (!params) return { display: '', isMono: false }

  // Bash: show $ {command}
  if (name === 'Bash' || name === 'bash' || name.toLowerCase().includes('bash')) {
    const cmd = params.command ?? params.cmd ?? params.script
    if (typeof cmd === 'string') {
      return { display: `$ ${cmd}`, isMono: true }
    }
  }

  // File operations: show file path
  const fileTools = ['Read', 'FileRead', 'Write', 'FileWrite', 'Edit', 'FileEdit']
  if (fileTools.some(t => name.toLowerCase().includes(t.toLowerCase()))) {
    const path = params.file_path ?? params.path ?? params.filePath ?? params.filename
    if (typeof path === 'string') {
      return { display: path, isMono: true }
    }
  }

  // Glob/Grep: show pattern + path
  if (name === 'Glob' || name === 'Grep') {
    const pattern = params.pattern ?? ''
    const path = params.path ?? ''
    const parts = [pattern, path].filter(Boolean).join(' in ')
    if (parts) return { display: parts, isMono: true }
  }

  // Default: JSON params
  return { display: JSON.stringify(params, null, 2), isMono: false }
}

// T-M19: AskUserQuestion card with interactive option buttons. Clicking an
// option invokes the onAnswer callback (App.tsx threads a sender that POSTs
// the selection back as a user message, mirroring what the Claude CLI does).
interface AskQuestion {
  question: string
  options: Array<{ label: string; description?: string }>
  header?: string
  multiSelect?: boolean
}

function AskUserQuestionCard({ questions, onAnswer }: {
  questions: Array<AskQuestion>
  onAnswer?: (answers: Array<{ question: string; answer: string }>) => void
}) {
  // Local state tracks selections across (potentially multiple) questions
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [submitted, setSubmitted] = useState(false)

  const pickOption = useCallback((qi: number, label: string) => {
    if (submitted) return
    setAnswers((prev) => ({ ...prev, [qi]: label }))
  }, [submitted])

  const submit = useCallback(() => {
    if (submitted || !onAnswer) return
    const payload = questions.map((q, qi) => ({
      question: q.question,
      answer: answers[qi] ?? '(skipped)',
    }))
    onAnswer(payload)
    setSubmitted(true)
  }, [answers, onAnswer, questions, submitted])

  const allAnswered = questions.every((_, qi) => answers[qi])

  return (
    <div className="bg-blue-50 dark:bg-blue-950/30 rounded-lg p-4 my-2 border border-blue-300 dark:border-blue-700/40 space-y-4">
      {questions.map((q, qi) => (
        <div key={qi}>
          <p className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">{q.question}</p>
          <div className="flex flex-wrap gap-2">
            {q.options.map((opt, oi) => {
              const picked = answers[qi] === opt.label
              const disabled = submitted || !onAnswer
              return (
                <button
                  key={oi}
                  onClick={() => pickOption(qi, opt.label)}
                  disabled={disabled}
                  aria-pressed={picked}
                  className={
                    'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ' +
                    (picked
                      ? 'bg-blue-600 text-white border-blue-700 dark:bg-blue-500 dark:border-blue-400'
                      : 'bg-blue-100 dark:bg-blue-600/20 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-600/30 hover:bg-blue-200 dark:hover:bg-blue-600/40') +
                    (disabled && !picked ? ' opacity-50 cursor-not-allowed' : '')
                  }
                  title={opt.description}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      {onAnswer && (
        <div className="flex justify-end pt-1">
          <button
            onClick={submit}
            disabled={!allAnswered || submitted}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitted ? 'Answered' : 'Submit'}
          </button>
        </div>
      )}
    </div>
  )
}

// B-05: Friendly label map for tools with empty input
const TOOL_STATUS_LABELS: Record<string, string> = {
  EnterPlanMode: 'Entering plan mode...',
  ExitPlanMode: 'Exiting plan mode...',
}

function ToolUseBlock({ name, input, onAnswerQuestion }: {
  name: string
  input: unknown
  onAnswerQuestion?: (answers: Array<{ question: string; answer: string }>) => void
}) {
  const { display, isMono } = useMemo(() => formatToolParams(name, input), [name, input])

  // T-M19: Render AskUserQuestion as interactive card with回传
  if (name === 'AskUserQuestion') {
    const questions = (input as Record<string, unknown>)?.questions as Array<AskQuestion> | undefined
    if (questions && Array.isArray(questions)) {
      return <AskUserQuestionCard questions={questions} onAnswer={onAnswerQuestion} />
    }
  }

  // B-05: Tools with empty input — show clean status label
  const params = input as Record<string, unknown> | null
  if (!params || Object.keys(params).length === 0) {
    const label = TOOL_STATUS_LABELS[name] || `${name}...`
    return <div className="text-gray-500 italic text-sm my-2">{label}</div>
  }

  return (
    <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-3 my-2 border border-gray-200 dark:border-gray-700">
      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <span>🔧</span>
        <span className="font-mono">{name}</span>
      </div>
      {display && (
        <pre className={`mt-2 text-xs bg-gray-200 dark:bg-gray-900 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all ${
          isMono ? 'font-mono' : ''
        }`}>
          {display}
        </pre>
      )}
    </div>
  )
}

// --- T-16: Tool result with collapse/expand ---

const COLLAPSED_LINES = 5
const MAX_DISPLAY_LINES = 500

// T-22/T-23: Tool name sets for routing results to specialized viewers
const FILE_READ_TOOLS = new Set(['read', 'fileread', 'write', 'filewrite', 'glob', 'globtool', 'grep', 'greptool'])
const FILE_EDIT_TOOLS = new Set(['edit', 'fileedit'])

/** Extract the file_path from tool_use input for file-related tools */
function extractFilePath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const params = input as Record<string, unknown>
  const path = params.file_path ?? params.path ?? params.filePath ?? params.filename
  return typeof path === 'string' ? path : undefined
}

function ToolResultBlock({ content, toolName, toolInput }: { content: unknown; toolName?: string; toolInput?: unknown }) {
  const text = useMemo(() => {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      // Handle content array format: [{type: "text", text: "..."}, ...]
      return content
        .map((c: unknown) => {
          if (typeof c === 'string') return c
          if (c && typeof c === 'object' && 'text' in (c as Record<string, unknown>)) {
            return (c as Record<string, unknown>).text as string
          }
          return JSON.stringify(c, null, 2)
        })
        .join('\n')
    }
    return JSON.stringify(content, null, 2)
  }, [content])

  // Delegate to BashResultBlock for Bash tool results
  if (toolName && (toolName === 'Bash' || toolName === 'bash' || toolName.toLowerCase().includes('bash'))) {
    return <BashResultBlock text={text} />
  }

  // T-23: FileEdit → DiffViewer
  if (toolName && FILE_EDIT_TOOLS.has(toolName.toLowerCase())) {
    const filePath = extractFilePath(toolInput)
    return <DiffViewer content={text} filePath={filePath} />
  }

  // T-22: FileRead/Glob/Grep → FileViewer (only when we have a file path)
  if (toolName && FILE_READ_TOOLS.has(toolName.toLowerCase())) {
    const filePath = extractFilePath(toolInput)
    if (filePath) {
      return <FileViewer content={text} filePath={filePath} />
    }
  }

  return <CollapsibleOutput text={text} />
}

function CollapsibleOutput({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)

  const lines = useMemo(() => text.split('\n'), [text])
  const totalLines = lines.length
  const isLong = totalLines > COLLAPSED_LINES
  const isTooLong = totalLines > MAX_DISPLAY_LINES

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text)
  }, [text])

  // Too long: special treatment
  if (isTooLong && !expanded) {
    return (
      <div className="bg-gray-800/80 rounded-lg p-3 my-2 border border-gray-700/50">
        <pre className="text-xs text-gray-400 whitespace-pre-wrap break-words overflow-x-auto">
          {lines.slice(0, COLLAPSED_LINES).join('\n')}
        </pre>
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={() => setExpanded(true)}
            className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
          >
            [Output too long ({totalLines} lines) - Click to expand]
          </button>
          <button
            onClick={handleCopy}
            className="text-xs text-gray-500 hover:text-gray-300 cursor-pointer ml-auto"
            title="Copy full output"
          >
            📋 Copy
          </button>
        </div>
      </div>
    )
  }

  // Normal collapsible
  if (isLong && !expanded) {
    return (
      <div className="bg-gray-800/80 rounded-lg p-3 my-2 border border-gray-700/50">
        <pre className="text-xs text-gray-400 whitespace-pre-wrap break-words overflow-x-auto">
          {lines.slice(0, COLLAPSED_LINES).join('\n')}
        </pre>
        <button
          onClick={() => setExpanded(true)}
          className="text-xs text-blue-400 hover:text-blue-300 mt-1 cursor-pointer"
        >
          [Show {totalLines - COLLAPSED_LINES} more lines]
        </button>
      </div>
    )
  }

  // Fully expanded or short enough
  return (
    <div className="bg-gray-800/80 rounded-lg p-3 my-2 border border-gray-700/50">
      <pre className="text-xs text-gray-400 whitespace-pre-wrap break-words overflow-x-auto">
        {text}
      </pre>
      {isLong && (
        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={() => setExpanded(false)}
            className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
          >
            [Collapse]
          </button>
          {isTooLong && (
            <button
              onClick={handleCopy}
              className="text-xs text-gray-500 hover:text-gray-300 cursor-pointer ml-auto"
              title="Copy full output"
            >
              📋 Copy
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// --- T-17: Bash output rendering ---

interface BashParsed {
  stdout: string
  stderr: string
  exitCode: number | null
}

function parseBashOutput(text: string): BashParsed {
  // Try to parse structured output (JSON with stdout/stderr/exit_code)
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      return {
        stdout: parsed.stdout ?? parsed.output ?? '',
        stderr: parsed.stderr ?? '',
        exitCode: parsed.exit_code ?? parsed.exitCode ?? parsed.returncode ?? null,
      }
    }
  } catch {
    // Not JSON — treat as raw output
  }

  // Heuristic: look for stderr markers in raw text
  // Some outputs include "stderr:" or "STDERR:" prefixes
  const stderrMatch = text.match(/(?:^|\n)(?:stderr|STDERR):\s*([\s\S]*?)(?:\n(?:stdout|STDOUT|exit_code):|$)/)
  const exitMatch = text.match(/(?:^|\n)(?:exit_code|Exit code|exitCode):\s*(\d+)/)

  if (stderrMatch || exitMatch) {
    const stderr = stderrMatch?.[1]?.trim() ?? ''
    const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null
    const stdout = text
      .replace(stderrMatch?.[0] ?? '', '')
      .replace(exitMatch?.[0] ?? '', '')
      .trim()
    return { stdout, stderr, exitCode }
  }

  return { stdout: text, stderr: '', exitCode: null }
}

function BashResultBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const parsed = useMemo(() => parseBashOutput(text), [text])

  const hasError = parsed.stderr || (parsed.exitCode !== null && parsed.exitCode !== 0)
  const fullOutput = [parsed.stdout, parsed.stderr].filter(Boolean).join('\n')
  const lines = fullOutput.split('\n')
  const totalLines = lines.length
  const isLong = totalLines > COLLAPSED_LINES
  const isTooLong = totalLines > MAX_DISPLAY_LINES

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(fullOutput)
  }, [fullOutput])

  const renderContent = (showAll: boolean) => {
    const stdoutLines = parsed.stdout.split('\n')
    const visibleStdoutLines = showAll ? stdoutLines : stdoutLines.slice(0, COLLAPSED_LINES)

    return (
      <>
        {/* Exit code badge if non-zero */}
        {parsed.exitCode !== null && parsed.exitCode !== 0 && (
          <div className="flex items-center gap-1 mb-2">
            <span className="text-xs bg-red-900/60 text-red-300 px-2 py-0.5 rounded font-mono">
              Exit code: {parsed.exitCode}
            </span>
          </div>
        )}

        {/* stdout */}
        {parsed.stdout && (
          <pre className="text-xs text-gray-300 whitespace-pre-wrap break-words overflow-x-auto">
            {showAll ? parsed.stdout : visibleStdoutLines.join('\n')}
          </pre>
        )}

        {/* stderr */}
        {parsed.stderr && showAll && (
          <pre className="text-xs text-orange-400 whitespace-pre-wrap break-words overflow-x-auto mt-1 border-l-2 border-orange-500/40 pl-2">
            {parsed.stderr}
          </pre>
        )}
      </>
    )
  }

  // Too long, collapsed
  if (isTooLong && !expanded) {
    return (
      <div className={`rounded-lg p-3 my-2 border ${
        hasError ? 'bg-red-950/30 border-red-800/40' : 'bg-gray-800/80 border-gray-700/50'
      }`}>
        {renderContent(false)}
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={() => setExpanded(true)}
            className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
          >
            [Output too long ({totalLines} lines) - Click to expand]
          </button>
          <button
            onClick={handleCopy}
            className="text-xs text-gray-500 hover:text-gray-300 cursor-pointer ml-auto"
            title="Copy full output"
          >
            📋 Copy
          </button>
        </div>
      </div>
    )
  }

  // Normal collapsible
  if (isLong && !expanded) {
    return (
      <div className={`rounded-lg p-3 my-2 border ${
        hasError ? 'bg-red-950/30 border-red-800/40' : 'bg-gray-800/80 border-gray-700/50'
      }`}>
        {renderContent(false)}
        <button
          onClick={() => setExpanded(true)}
          className="text-xs text-blue-400 hover:text-blue-300 mt-1 cursor-pointer"
        >
          [Show {totalLines - COLLAPSED_LINES} more lines]
        </button>
      </div>
    )
  }

  // Fully expanded or short
  return (
    <div className={`rounded-lg p-3 my-2 border ${
      hasError ? 'bg-red-950/30 border-red-800/40' : 'bg-gray-800/80 border-gray-700/50'
    }`}>
      {renderContent(true)}
      {isLong && (
        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={() => setExpanded(false)}
            className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
          >
            [Collapse]
          </button>
          {isTooLong && (
            <button
              onClick={handleCopy}
              className="text-xs text-gray-500 hover:text-gray-300 cursor-pointer ml-auto"
              title="Copy full output"
            >
              📋 Copy
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// --- T-18: Status messages ---

function StatusMessage({ msg }: { msg: ChatMessage }) {
  const subtype = (msg as Record<string, unknown>).subtype as string | undefined

  // Extract display text from various message shapes
  const getText = (): string => {
    const content = msg.message?.content
    if (typeof content === 'string') return content

    // Try message-level text fields
    const raw = msg as Record<string, unknown>
    if (typeof raw.message === 'string') return raw.message
    if (typeof raw.text === 'string') return raw.text
    if (typeof raw.error === 'string') return raw.error

    // Fallback
    return typeof content !== 'undefined'
      ? JSON.stringify(content)
      : JSON.stringify(msg.message ?? msg)
  }

  const text = getText()

  switch (subtype) {
    case 'status':
      return (
        <div className="flex justify-center mb-2">
          <p className="text-xs text-gray-500 italic px-3 py-0.5">
            {text}
          </p>
        </div>
      )

    case 'api_retry':
      return (
        <div className="flex justify-center mb-2">
          <p className="text-xs text-yellow-500 bg-yellow-900/20 rounded-full px-4 py-1">
            ⟳ {text || 'Retrying API request...'}
          </p>
        </div>
      )

    case 'rate_limit':
      return (
        <div className="flex justify-center mb-2">
          <p className="text-xs text-orange-400 bg-orange-900/20 rounded-full px-4 py-1">
            ⚠ {text || 'Rate limited — waiting...'}
          </p>
        </div>
      )

    default:
      // Unknown subtype: show with label
      return (
        <div className="flex justify-center mb-2">
          <p className="text-xs text-gray-500 bg-gray-800/50 rounded-full px-4 py-1 break-words overflow-x-auto">
            {subtype ? `[${subtype}] ` : ''}{text}
          </p>
        </div>
      )
  }
}

// --- Content block renderers ---

function TextBlock({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return (
    <div
      className="prose prose-invert prose-sm max-w-none
        [&_pre]:bg-gray-950 [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:overflow-x-auto
        [&_code]:text-xs [&_code]:sm:text-sm [&_p]:leading-relaxed
        [&_.hljs]:text-xs [&_.hljs]:sm:text-sm
        break-words"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function ThinkingBlock({ thinking }: { thinking: string }) {
  return (
    <details className="my-2 group">
      <summary className="cursor-pointer text-xs text-gray-400 select-none
        group-open:mb-1 hover:text-gray-300 min-h-[44px] flex items-center">
        <span className="thinking-chevron inline-block transition-transform duration-200 mr-1 group-open:rotate-90">&#9654;</span>
        Thinking...
      </summary>
      <div className="thinking-content bg-gray-800/50 rounded-md p-3 text-xs text-gray-400 italic whitespace-pre-wrap break-words overflow-x-auto border border-gray-700/50">
        {thinking}
      </div>
    </details>
  )
}

// --- Content array renderer ---

/** Track the last tool_use name so we can pass it to the next tool_result block */
function AssistantContent({ content, onAnswerQuestion }: {
  content: unknown
  onAnswerQuestion?: (answers: Array<{ question: string; answer: string }>) => void
}) {
  if (typeof content === 'string') {
    return <TextBlock text={content} />
  }
  if (!Array.isArray(content)) {
    return <pre className="text-xs text-gray-500">{JSON.stringify(content, null, 2)}</pre>
  }

  // Build maps of tool_use id -> name and id -> input for tool_result rendering
  const toolNameMap = new Map<string, string>()
  const toolInputMap = new Map<string, unknown>()
  for (const block of content) {
    if (block && typeof block === 'object' && 'type' in block) {
      const b = block as Record<string, unknown>
      if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        toolNameMap.set(b.id, b.name)
        toolInputMap.set(b.id, b.input)
      }
    }
  }

  return (
    <>
      {content.map((block: unknown, i: number) => {
        // Guard against null, string, or non-object entries
        if (typeof block === 'string') {
          return <TextBlock key={i} text={block} />
        }
        if (typeof block !== 'object' || block === null || !('type' in block)) {
          return (
            <pre key={i} className="text-xs text-gray-500 my-1 break-words overflow-x-auto">
              {JSON.stringify(block, null, 2)}
            </pre>
          )
        }
        const b = block as Record<string, unknown>
        switch (b.type) {
          case 'text':
            return <TextBlock key={i} text={b.text as string} />
          case 'thinking':
            return <ThinkingBlock key={i} thinking={b.thinking as string} />
          case 'tool_use':
            return <ToolUseBlock key={i} name={b.name as string} input={b.input} onAnswerQuestion={onAnswerQuestion} />
          case 'tool_result': {
            const toolId = b.tool_use_id as string | undefined
            const toolName = toolId ? toolNameMap.get(toolId) : undefined
            const toolInput = toolId ? toolInputMap.get(toolId) : undefined
            return <ToolResultBlock key={i} content={b.content} toolName={toolName} toolInput={toolInput} />
          }
          default:
            return (
              <pre key={i} className="text-xs text-gray-500 my-1 break-words overflow-x-auto">
                {JSON.stringify(b, null, 2)}
              </pre>
            )
        }
      })}
    </>
  )
}

// --- Main component ---

export interface ChatMessage {
  type: string
  message?: {
    role?: string
    content?: unknown
  }
  /** Marker for streaming-in-progress messages (set by App.tsx) */
  _streaming?: boolean
  [key: string]: unknown
}

export default function MessageRenderer({
  msg,
  onAnswerQuestion,
}: {
  msg: ChatMessage
  onAnswerQuestion?: (answers: Array<{ question: string; answer: string }>) => void
}) {
  switch (msg.type) {
    case 'assistant':
      return (
        <div className="flex justify-start mb-4">
          <div className="max-w-[85%] sm:max-w-[70%]">
            <AssistantContent content={msg.message?.content} onAnswerQuestion={onAnswerQuestion} />
            {msg._streaming && (
              <span className="inline-block w-2 h-4 bg-blue-400 animate-pulse rounded-sm ml-0.5 align-text-bottom" />
            )}
          </div>
        </div>
      )

    case 'user':
      return (
        <div className="flex justify-end mb-4">
          <div className="bg-gray-200 dark:bg-blue-600 text-gray-900 dark:text-white rounded-2xl rounded-br-md px-4 py-2 max-w-[85%] sm:max-w-[70%]">
            <p className="text-sm whitespace-pre-wrap break-words overflow-x-auto">
              {typeof msg.message?.content === 'string'
                ? msg.message.content
                : JSON.stringify(msg.message?.content)}
            </p>
          </div>
        </div>
      )

    case 'system':
      // T-18: Route system messages by subtype
      return <StatusMessage msg={msg} />

    case 'result': {
      // T-M17: surface usage + cost + duration as a compact footer line
      const raw = msg as unknown as Record<string, unknown>
      const usage = raw.usage as UsageLike | undefined
      const cost = typeof raw.total_cost_usd === 'number' ? raw.total_cost_usd : undefined
      const duration = typeof raw.duration_ms === 'number' ? raw.duration_ms : undefined
      const textContent = typeof msg.message?.content === 'string' ? msg.message.content : null

      return (
        <div className="flex justify-center mb-4">
          <div className="flex flex-col items-center max-w-[85%] sm:max-w-[70%]">
            {textContent && (
              <p className="text-xs text-gray-400 italic break-words overflow-x-auto">
                {textContent}
              </p>
            )}
            <CostFooter usage={usage} totalCostUsd={cost} durationMs={duration} />
          </div>
        </div>
      )
    }

    default:
      // Unknown type: render raw JSON for debugging
      return (
        <div className="flex justify-start mb-4">
          <details className="max-w-[85%]">
            <summary className="text-xs text-gray-500 cursor-pointer">
              Unknown message type: {msg.type ?? 'undefined'}
            </summary>
            <pre className="text-xs text-gray-600 mt-1 bg-gray-800/50 rounded p-2 overflow-x-auto break-words">
              {JSON.stringify(msg, null, 2)}
            </pre>
          </details>
        </div>
      )
  }
}
