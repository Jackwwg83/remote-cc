# remote-cc 协议规范

> 严格对齐原版 Claude Code stream-json 协议。
> relay 做最小信封解析（auth + control type），不解析对话内容。
> 参考源码：`controlSchemas.ts`、`coreSchemas.ts`、`structuredIO.ts`、`SessionsWebSocket.ts`、`directConnectManager.ts`

## 1. 传输层

### WebSocket 端点

```
CLI bridge → relay:  WSS /v1/sessions/:id/cli
手机 web   → relay:  WSS /v1/sessions/:id/client
```

每条 WebSocket 消息是一行 JSON（NDJSON 格式），以 `\n` 分隔。

### 认证握手

WebSocket 连接通过 HTTP header 认证（对齐原版 `SessionsWebSocket.ts:113`）：

```
CLI  连接: Authorization: Bearer <admin_token>
手机连接: Authorization: Bearer <session_client_token>
```

relay 在 WebSocket upgrade 时验证 token，失败返回 HTTP 401 不升级。

注意：原版 Claude Code 使用 HTTP header 认证（不是 first-frame auth message）。remote-cc 对齐此行为。

### 心跳

```
PING_INTERVAL_MS = 30000  (30 秒)
```

两端每 30 秒发 WebSocket ping frame（协议级）。relay 回 pong。同时支持应用层心跳：

```json
{ "type": "keep_alive" }
```

超过 2 个周期（60s）无 ping/pong → 判定断线。

### 重连

```
RECONNECT_DELAY_MS     = 2000   (首次 2 秒)
MAX_RECONNECT_ATTEMPTS = 5      (最多 5 次)
BACKOFF_MULTIPLIER     = 2      (指数退避)
```

断线后 2s → 4s → 8s → 16s → 32s，共 5 次。全部失败 → 报错退出。

### 关闭码

| code | 含义 | 行为 |
|------|------|------|
| 1000 | 正常关闭 | 不重连 |
| 1001 | going away（server shutdown） | 重连 |
| 4001 | session not found | 有限重试（最多 3 次，可能是暂态） |
| 4003 | unauthorized | **永久关闭，不重连** |
| 4004 | session expired | 不重连，通知用户 |
| 其他 | 临时错误 | 自动重连 |

## 2. 消息协议

### Stdin 消息（手机 → relay → bridge → claude stdin）

完整的 StdinMessage union（对齐 `controlSchemas.ts:StdinMessageSchema`）：

```typescript
StdinMessage =
  | SDKUserMessage                    // 用户 prompt（文本/图片/附件）
  | SDKControlRequest                 // 控制请求（下列 subtype）
  | SDKControlResponse                // 控制响应（权限审批结果）
  | SDKKeepAlive                      // 心跳
  | SDKUpdateEnvironmentVariables     // 环境变量更新
```

**SDKControlRequest 的所有 subtype**（对齐 `controlSchemas.ts:SDKControlRequestInnerSchema`）：

| subtype | 说明 | 谁发 |
|---------|------|------|
| `initialize` | 初始化会话（hooks、MCP、agents 配置） | bridge |
| `interrupt` | 中断当前 turn | 手机 |
| `can_use_tool` | 请求使用工具（由 claude 发出，见 Stdout） | — |
| `set_permission_mode` | 设置权限模式 | 手机 |
| `set_model` | 切换模型 | 手机 |
| `set_max_thinking_tokens` | 设置思考 token 上限 | 手机 |
| `mcp_status` | 查询 MCP 状态 | 手机 |
| `get_context_usage` | 查询上下文用量 | 手机 |
| `mcp_message` | MCP 协议消息 | bridge |
| `reload_plugins` | 重载插件 | 手机 |
| `stop_task` | 停止后台任务 | 手机 |
| `get_settings` | 获取设置 | 手机 |
| `elicitation` | 信息收集响应 | 手机 |

### Stdout 消息（claude stdout → bridge → relay → 手机）

完整的 StdoutMessage union（对齐 `controlSchemas.ts:StdoutMessageSchema`）：

```typescript
StdoutMessage =
  // === SDK 消息（24 种）===
  | SDKAssistantMessage              // AI 回复（完整 turn）
  | SDKUserMessage                   // 用户消息回显
  | SDKUserMessageReplay             // 用户消息重放
  | SDKResultMessage                 // 会话结果
  | SDKSystemMessage                 // 系统消息
  | SDKPartialAssistantMessage       // 流式 AI 回复（逐 token/block）
  | SDKCompactBoundaryMessage        // 压缩边界
  | SDKStatusMessage                 // 状态变更
  | SDKAPIRetryMessage               // API 重试
  | SDKLocalCommandOutputMessage     // 本地命令输出
  | SDKHookStartedMessage            // Hook 开始
  | SDKHookProgressMessage           // Hook 进度
  | SDKHookResponseMessage           // Hook 结果
  | SDKToolProgressMessage           // 工具执行进度
  | SDKAuthStatusMessage             // 认证状态
  | SDKTaskNotificationMessage       // 任务通知
  | SDKTaskStartedMessage            // 任务开始
  | SDKTaskProgressMessage           // 任务进度
  | SDKSessionStateChangedMessage    // 会话状态变更
  | SDKFilesPersistedEvent           // 文件持久化事件
  | SDKToolUseSummaryMessage         // 工具调用摘要
  | SDKRateLimitEvent                // 限流事件
  | SDKElicitationCompleteMessage    // 信息收集完成
  | SDKPromptSuggestionMessage       // prompt 建议

  // === 精简消息 ===
  | SDKStreamlinedTextMessage        // 精简文本输出
  | SDKStreamlinedToolUseSummaryMessage  // 精简工具摘要
  | SDKPostTurnSummaryMessage        // turn 结束摘要

  // === 控制消息 ===
  | SDKControlResponse               // 控制响应
  | SDKControlRequest                // 控制请求（权限审批请求 → 手机）
  | SDKControlCancelRequest          // 取消控制请求
  | SDKKeepAlive                     // 心跳
```

### Feature-gating 矩阵

以下消息类型需要对应的启动 flag 才会出现：

| 消息类型 | 需要的 flag/env |
|---------|----------------|
| `SDKHookStartedMessage` / `Progress` / `Response` | `--include-hook-events` 或 `CLAUDE_CODE_REMOTE=true` |
| `SDKPartialAssistantMessage` | `--include-partial-messages` |
| `SDKAuthStatusMessage` | `--enable-auth-status` |
| `SDKUserMessageReplay` | `--replay-user-messages` |
| `SDKPromptSuggestionMessage` | `initialize` 请求中 `promptSuggestions: true` |

bridge spawn claude 时必须带上这些 flag（见第 6 节）。

## 3. 关键消息格式

### 用户消息（手机发 prompt）

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "帮我看看这个 bug"
  },
  "parent_tool_use_id": null,
  "session_id": ""
}
```

附带图片：
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "type": "text", "text": "这个截图里的按钮" },
      { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } }
    ]
  },
  "parent_tool_use_id": null,
  "session_id": ""
}
```

### AI 回复

```json
{
  "type": "assistant",
  "message": {
    "id": "msg_xxx",
    "type": "message",
    "role": "assistant",
    "content": [
      { "type": "thinking", "thinking": "let me look at..." },
      { "type": "text", "text": "我看了一下代码..." },
      { "type": "tool_use", "id": "tu_xxx", "name": "Bash", "input": { "command": "git diff" } }
    ],
    "model": "claude-sonnet-4-20250514",
    "stop_reason": "end_turn",
    "stop_sequence": null,
    "usage": {
      "input_tokens": 1234,
      "output_tokens": 567,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 0
    }
  },
  "uuid": "xxx",
  "parent_tool_use_id": null,
  "session_id": "",
  "timestamp": "2026-04-02T..."
}
```

### 权限审批请求（claude → bridge → relay → 手机）

```json
{
  "type": "control_request",
  "request_id": "req_xxx",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "Bash",
    "tool_use_id": "tu_xxx",
    "input": { "command": "rm -rf node_modules" },
    "title": "Execute Bash command",
    "display_name": "Bash",
    "description": "rm -rf node_modules",
    "permission_suggestions": [],
    "blocked_path": null,
    "decision_reason": null,
    "agent_id": null
  }
}
```

### 权限审批结果（手机 → relay → bridge → claude）

允许：
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "req_xxx",
    "response": {
      "behavior": "allow",
      "updatedInput": null
    }
  }
}
```

拒绝：
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "req_xxx",
    "response": {
      "behavior": "deny",
      "message": "User denied this operation"
    }
  }
}
```

### 取消权限请求

```json
{
  "type": "control_cancel_request",
  "request_id": "req_xxx"
}
```

### 中断

```json
{
  "type": "control_request",
  "request_id": "req_xxx",
  "request": {
    "subtype": "interrupt"
  }
}
```

## 4. 会话生命周期

### 状态机

```
creating → running → detached → stopped
              ↑          ↓
              └─ reattach ┘
```

| 状态 | 含义 | 触发 |
|------|------|------|
| `creating` | session 刚创建，等 bridge spawn claude | POST /sessions |
| `running` | CLI 在执行，至少一个 client 连接 | bridge + client 都连上 |
| `detached` | client 断开，CLI 继续后台执行 | client WebSocket close |
| `stopped` | 会话结束 | idle timeout / DELETE / claude 进程退出 |

### Turn 结束判定

**不要用 `SDKResultMessage` 判断 turn 结束**（Codex review 指出：result 后还可能有 task_started/post_turn_summary）。

权威的 turn-over 信号是：
- `SDKSessionStateChangedMessage` 中 state 变为 `idle`
- 或 claude 子进程退出

### Session API

```
POST   /v1/sessions
  Headers: Authorization: Bearer <admin_token>
  Body:    { "cwd": "/path/to/project" }
  Returns: { "session_id": "xxx", "ws_url": "wss://relay.example.com/v1/sessions/xxx/client", "work_dir": "/path", "client_token": "ct_xxx" }

GET    /v1/sessions
  Headers: Authorization: Bearer <admin_token>
  Returns: [{ "id": "xxx", "status": "running", "created_at": 123, "work_dir": "/path" }]

GET    /v1/sessions/:id
  Headers: Authorization: Bearer <admin_token>
  Returns: { "id": "xxx", "status": "running", ... }

DELETE /v1/sessions/:id
  Headers: Authorization: Bearer <admin_token>
  Returns: { "ok": true }
  行为: 给 claude 进程发 SIGTERM，session 标记 stopped，通知 client 断开
```

### outstanding 权限请求处理

session 被 DELETE 或 idle timeout 时，如果有未决的 `can_use_tool` 请求：
- relay 向 bridge 发送 `control_cancel_request` 取消所有 pending 请求
- bridge 收到后向 claude stdin 写入 deny response
- 防止 claude 进程卡在等待审批

## 5. relay 消息处理

### 最小信封解析

relay 不解析消息内容，但会解析以下字段用于路由和生命周期管理：

```
解析的字段：
  - type         → 路由决策（control_request 需要特殊处理）
  - subtype      → 区分 can_use_tool vs interrupt vs initialize
  - request_id   → 跟踪 pending 权限请求
  - session_id   → 路由到正确的 session（从 URL path 取，不从消息体）

不解析的字段：
  - message.content（对话内容）
  - input（工具参数）
  - tool_name / tool_use_id 的语义
```

### 消息缓存（断线重连）

```
缓存策略: Time/byte-bounded ring buffer + reconnect cursor
- 每个 session 维护一个 ring buffer
- 上限: 10MB 或 1 小时（先到先清）
- 每条消息带 sequence number
- client 重连时发送 last_seq → relay 从 last_seq+1 开始重放
- 重放消息带 { "replayed": true } 标记，client 去重

重连协议:
  client 重连 WebSocket 时 URL 带 query param:
  WSS /v1/sessions/:id/client?last_seq=1234
  
  relay 响应: 从 seq 1235 开始推送缓存的消息，然后切换到实时流
```

### relay 持久化

```
/var/lib/remote-cc/sessions.json — session index（id、status、created_at、work_dir）

relay 重启行为：
  1. 读取 sessions.json
  2. 所有 running session 标记为 detached
  3. 等待 bridge 重连 reattach
  4. 超过 idle_timeout 未 reattach → 清理
  
注意：消息 buffer 不持久化（内存中），relay 重启后 buffer 清空。
bridge 重连后 claude 进程仍然活着（bridge 进程没重启），会话可以继续。
```

## 6. bridge spawn 命令

```bash
claude --print \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --include-hook-events \
  --replay-user-messages
```

环境变量：
```bash
CLAUDE_CODE_ENVIRONMENT_KIND=bridge    # 触发 setSessionSource('remote-control')
```

注意：不需要 `--sdk-url`（那是连 Anthropic CCR 后端用的）。不需要 `CLAUDE_CODE_REMOTE=true`（那是 CCR 容器内部用的）。需要测试不传 `--session-id` 时 claude 是否正常工作，如果报错则传 `--session-id` + 生成的 UUID。

### initialize 握手（关键！）

claude 进程启动后第一件事是向 stdout 发出 `control_request (subtype: initialize)`。
**bridge 必须回复 initialize response，否则 claude 不会开始处理用户消息。**

bridge 收到：
```json
{
  "type": "control_request",
  "request_id": "req_init_xxx",
  "request": {
    "subtype": "initialize"
  }
}
```

bridge 回复（写入 claude stdin）：
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "req_init_xxx",
    "response": {
      "commands": [],
      "agents": [],
      "output_style": "normal",
      "available_output_styles": ["normal"],
      "models": [],
      "account": {},
      "pid": 12345
    }
  }
}
```

参考：rdcc `controlSchemas.ts:SDKControlInitializeResponseSchema`

### buffered line reader/writer

bridge 必须实现 buffered line reader 处理 stdin/stdout：

```
claude stdout data 事件不保证一行完整 JSON。
必须缓冲到 \n 边界才解析。

伪代码：
  buffer = ""
  claude.stdout.on('data', chunk => {
    buffer += chunk
    while ((idx = buffer.indexOf('\n')) !== -1) {
      line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      message = JSON.parse(line)
      relay.send(message)
    }
  })
```

### child process 生命周期

| 事件 | bridge 行为 |
|------|------------|
| spawn 失败（claude 不在 PATH） | 报错退出，通知 relay session failed |
| claude 非零退出 | 通知 relay session stopped，重连时可 respawn |
| claude stdout 畸形 JSON | 跳过该行，log warning，不崩溃 |
| claude 进程死亡 | 通知 relay，session 标记 stopped |
| relay 断线 | bridge 保持 claude 运行，尝试重连 relay |
| bridge 退出 | 给 claude 发 SIGTERM，等 5s，SIGKILL |

### cwd 安全

bridge 配置文件中指定允许的目录列表：

```json
{
  "allowed_cwd": ["/Users/jack/projects", "/home/jack/work"],
  "relay": "wss://my-vps.com"
}
```

session 创建时 relay 传过来的 cwd 必须在白名单中，否则 bridge 拒绝。

## 7. 对未知消息类型的容错

原版 Claude Code 随版本更新可能新增消息类型。remote-cc 的处理原则：

```
relay:  有 type 字段且是 string → 转发。不识别的 type → 照转不丢。
bridge: stdout 一行合法 JSON + 有 type 字段 → 转发到 relay。
web:    不识别的 type → 静默忽略，不崩溃。可选在 debug 面板显示。
```

这样 remote-cc 不需要跟 Claude Code 版本同步更新——新消息类型自动透传。
