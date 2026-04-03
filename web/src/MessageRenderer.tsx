// T-11: Message renderer for remote-cc web UI

import { useMemo } from 'react'
import { marked } from 'marked'
import hljs from 'highlight.js'
import DOMPurify from 'dompurify'
import 'highlight.js/styles/github-dark.min.css'

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

// --- Content block renderers ---

function TextBlock({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return (
    <div
      className="prose prose-invert prose-sm max-w-none
        [&_pre]:bg-gray-950 [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:overflow-x-auto
        [&_code]:text-sm [&_p]:leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function ThinkingBlock({ thinking }: { thinking: string }) {
  return (
    <details className="my-2 group">
      <summary className="cursor-pointer text-xs text-gray-400 select-none
        group-open:mb-1 hover:text-gray-300">
        Thinking...
      </summary>
      <div className="bg-gray-800/50 rounded-md p-3 text-xs text-gray-400 whitespace-pre-wrap break-words overflow-x-auto border border-gray-700/50">
        {thinking}
      </div>
    </details>
  )
}

function ToolUseBlock({ name, input }: { name: string; input: unknown }) {
  return (
    <div className="my-2 bg-gray-800 rounded-md border border-gray-700/50 overflow-hidden">
      <div className="px-3 py-1.5 bg-gray-750 border-b border-gray-700/50 flex items-center gap-2">
        <span className="text-xs font-mono text-yellow-400/80">tool</span>
        <span className="text-sm font-mono text-gray-200 break-words overflow-x-auto">{name}</span>
      </div>
      <pre className="p-3 text-xs text-gray-400 overflow-x-auto break-words">
        {JSON.stringify(input, null, 2)}
      </pre>
    </div>
  )
}

function ToolResultBlock({ content }: { content: unknown }) {
  return (
    <div className="bg-gray-800 rounded p-2 text-sm">
      <pre className="whitespace-pre-wrap break-all overflow-x-auto">
        {typeof content === 'string' ? content : JSON.stringify(content, null, 2)}
      </pre>
    </div>
  )
}

// --- Content array renderer ---

function AssistantContent({ content }: { content: unknown }) {
  if (typeof content === 'string') {
    return <TextBlock text={content} />
  }
  if (!Array.isArray(content)) {
    return <pre className="text-xs text-gray-500">{JSON.stringify(content, null, 2)}</pre>
  }
  return (
    <>
      {content.map((block: unknown, i: number) => {
        // Fix 5: Guard against null, string, or non-object entries in content array
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
            return <ToolUseBlock key={i} name={b.name as string} input={b.input} />
          case 'tool_result':
            return <ToolResultBlock key={i} content={b.content} />
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

export default function MessageRenderer({ msg }: { msg: ChatMessage }) {
  switch (msg.type) {
    case 'assistant':
      return (
        <div className="flex justify-start mb-4">
          <div className="max-w-[85%] md:max-w-[75%]">
            <AssistantContent content={msg.message?.content} />
            {msg._streaming && (
              <span className="inline-block w-2 h-4 bg-blue-400 animate-pulse rounded-sm ml-0.5 align-text-bottom" />
            )}
          </div>
        </div>
      )

    case 'user':
      return (
        <div className="flex justify-end mb-4">
          <div className="bg-blue-600 rounded-2xl rounded-br-md px-4 py-2 max-w-[85%] md:max-w-[75%]">
            <p className="text-sm whitespace-pre-wrap break-words overflow-x-auto">
              {typeof msg.message?.content === 'string'
                ? msg.message.content
                : JSON.stringify(msg.message?.content)}
            </p>
          </div>
        </div>
      )

    case 'system':
      return (
        <div className="flex justify-center mb-4">
          <p className="text-xs text-gray-500 bg-gray-800/50 rounded-full px-4 py-1 break-words overflow-x-auto">
            {typeof msg.message?.content === 'string'
              ? msg.message.content
              : JSON.stringify(msg.message)}
          </p>
        </div>
      )

    case 'result':
      return (
        <div className="flex justify-center mb-4">
          <p className="text-xs text-gray-400 italic break-words overflow-x-auto">
            {typeof msg.message?.content === 'string'
              ? msg.message.content
              : `Result: ${JSON.stringify(msg.message ?? msg)}`}
          </p>
        </div>
      )

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
