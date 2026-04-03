/**
 * Shared message types for remote-cc bridge and web.
 * Aligned with Claude Code stream-json SDK protocol.
 */

// === Stdin messages (client → bridge → claude) ===

export interface SDKUserMessage {
  type: 'user'
  message: {
    role: 'user'
    content: string | ContentBlock[]
  }
  parent_tool_use_id: string | null
  session_id: string
}

export interface SDKControlRequest {
  type: 'control_request'
  request_id: string
  request: ControlRequestInner
}

export interface SDKControlResponse {
  type: 'control_response'
  response: ControlResponseInner
}

export interface SDKKeepAlive {
  type: 'keep_alive'
}

// === Control request subtypes ===

export type ControlRequestInner =
  | { subtype: 'initialize' }
  | { subtype: 'interrupt' }
  | { subtype: 'can_use_tool'; tool_name: string; tool_use_id: string; input: Record<string, unknown>; title?: string; display_name?: string; description?: string; permission_suggestions?: unknown[]; blocked_path?: string | null; decision_reason?: string | null; agent_id?: string | null }
  | { subtype: 'set_permission_mode'; mode: string }
  | { subtype: 'set_model'; model?: string }
  | { subtype: 'set_max_thinking_tokens'; max_thinking_tokens: number | null }
  | { subtype: 'mcp_status' }
  | { subtype: 'get_context_usage' }
  | { subtype: 'stop_task' }
  | { subtype: string; [key: string]: unknown }  // 容错：未知 subtype 透传

// === Control response ===

export interface ControlResponseInner {
  subtype: 'success' | 'error'
  request_id: string
  response?: Record<string, unknown>
  error?: string
}

// === Content blocks ===

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | ContentBlock[] }
  | { type: 'image'; source: ImageSource }

export interface ImageSource {
  type: 'base64'
  media_type: string
  data: string
}

// === Stdout message (any type from claude) ===
// We don't enumerate all 31 types — use discriminated union on `type` field
// Unknown types are passed through (forward compatibility)

export interface BaseMessage {
  type: string
  [key: string]: unknown
}

// === Session state ===

export type SessionState = 'creating' | 'running' | 'detached' | 'stopped'

// === Connection state ===

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
