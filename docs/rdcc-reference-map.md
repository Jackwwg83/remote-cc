# rdcc 源码参考地图

> remote-cc 的每个组件应该参考 rdcc 中对应的实现。
> 除 Anthropic 认证和后端（OAuth、JWT、claude.ai API）外，所有业务逻辑都以 rdcc 原版为准。
> 源码目录：参考 Claude Code 反编译源码的 `src/` 目录

## bridge 组件

bridge 是本地桥接进程。参考 rdcc 的 `src/remote/` 和 `src/bridge/`。

### WebSocket 客户端 + 重连

**参考**: `src/remote/SessionsWebSocket.ts` (404 行)

包含的逻辑（全部复用）：
- WebSocket 状态机：connecting → connected → closed
- 重连：2s backoff × 5 次，指数退避
- close code 处理：4001 有限重试、4003 永久关闭
- ping/pong 心跳：30s 间隔
- 消息解析：isSessionsMessage 验证

**替换的部分**：
- ❌ `getOauthConfig().BASE_API_URL` → 改为 relay URL
- ❌ `getAccessToken()` OAuth → 改为 admin token
- ❌ `organization_uuid` query param → 不需要

### Session 管理

**参考**: `src/remote/RemoteSessionManager.ts` (343 行)

包含的逻辑（全部复用）：
- connect() / disconnect() / reconnect()
- sendMessage()：发送 user message 到 session
- respondToPermission()：转发权限审批结果
- sendInterrupt()：发送中断信号
- isConnected() 状态查询

**替换的部分**：
- ❌ 构造函数里的 OAuth 相关参数

### 消息适配

**参考**: `src/remote/sdkMessageAdapter.ts` (302 行)

包含的逻辑（全部复用）：
- convertAssistantMessage()：SDKAssistantMessage → AssistantMessage
- convertStreamEvent()：SDKPartialAssistantMessage → StreamEvent
- convertResultMessage()：SDKResultMessage → SystemMessage
- convertStatusMessage()
- convertSystemMessage()

**说明**：Web UI 如果直接渲染 SDK 格式可以不用这个适配层。但如果要复用 rdcc 的 React 组件，需要这个转换。

### 权限桥接

**参考**: `src/remote/remotePermissionBridge.ts` (78 行)

包含的逻辑（全部复用）：
- createSyntheticAssistantMessage()：为远程权限请求创建 AssistantMessage
- createToolStub()：为本地不存在的 MCP 工具创建 stub

### 入站消息处理

**参考**: `src/bridge/inboundMessages.ts` (80 行)

包含的逻辑（全部复用）：
- extractInboundMessageFields()：从 SDKMessage 提取 content 和 uuid
- normalizeImageBlocks()：修复 iOS/web 客户端发送的 camelCase `mediaType` → snake_case `media_type`

### 消息收发协议

**参考**: `src/bridge/bridgeMessaging.ts` (461 行)

包含的逻辑：
- 消息入队（enqueue user message）
- control_response 处理（权限审批结果转发）
- 消息过滤（哪些消息需要转发、哪些跳过）
- virtual message 处理

**替换的部分**：
- ❌ CCR session API 调用 → 改为直接 WebSocket 转发

### 传输层抽象

**参考**: `src/bridge/replBridgeTransport.ts` (370 行)

包含的逻辑：
- createV1ReplTransport / createV2ReplTransport
- WebSocket → REPL 的消息桥接
- transport 生命周期

### 终端 UI（QR code + 状态）

**参考**: `src/bridge/bridgeUI.ts` (530 行)

包含的逻辑（全部复用）：
- QR code 生成（使用 `qrcode` npm 包的 `toString`）
- QR 配置：`{ type: 'terminal', errorCorrectionLevel: 'L', margin: 1 }`
- 连接状态显示（Ready / Connecting / Connected）
- spinner 动画
- 终端行数计算（考虑 line wrapping）

### 会话执行（子进程管理）

**参考**: `src/bridge/sessionRunner.ts` (550 行)

包含的逻辑：
- spawn 子进程
- stdin/stdout 双向桥接
- 子进程生命周期（退出、崩溃、重启）
- 信号处理（SIGTERM、SIGINT）

**替换的部分**：
- ❌ 原版 spawn 的是 CCR 容器里的进程 → 改为 spawn 本机 `claude -p --input-format stream-json --output-format stream-json`

### Bridge 主循环

**参考**: `src/bridge/bridgeMain.ts` (2999 行)

这是最大的文件，包含完整的 remote control 生命周期：
- runBridgeLoop()：主轮询循环
- heartbeat：定期心跳保活
- token refresh：JWT 自动刷新
- session 状态机
- 多 session 管理
- 错误恢复

**大部分需要简化**：原版是 HTTP 长轮询 + Anthropic 云，我们是 WebSocket 直连 relay。但状态机和错误恢复逻辑可以参考。

## relay 组件

relay 是云端 Go 服务。参考 rdcc 的 `src/server/` 来反推 server 端 API 设计。

### 直连管理（客户端实现 → 反推 server 行为）

**参考**: `src/server/directConnectManager.ts` (213 行)

这是 server 的**客户端侧**代码，从中可以反推 server 需要：
- WebSocket 消息解析（按 type 路由）
- control_request (can_use_tool) → 转发给 client
- control_response → 转发给 CLI
- interrupt → 转发给 CLI
- error response → 回复 unrecognized subtype
- sendMessage()：SDKUserMessage 格式

### 创建会话（客户端实现 → 反推 API）

**参考**: `src/server/createDirectConnectSession.ts` (88 行)

从这个客户端代码反推 server API：
- POST /sessions → 返回 `{ session_id, ws_url, work_dir }`
- Authorization: Bearer token
- Body: `{ cwd, dangerously_skip_permissions }`

### 类型定义

**参考**: `src/server/types.ts` (57 行)

直接复用的类型：
- `SessionState`: 'starting' | 'running' | 'detached' | 'stopping' | 'stopped'
- `SessionInfo`: id, status, createdAt, workDir, process
- `SessionIndex`: session key → metadata 的映射
- `connectResponseSchema`: Zod schema 验证响应格式

## web 组件

web 是 React PWA。参考 rdcc 的 UI 组件来理解消息渲染逻辑。

### StructuredIO（stream-json 解析器）

**参考**: `src/cli/structuredIO.ts` (859 行)

**重要**：这是 Web UI 解析 relay 推来的消息的核心参考：
- buffered line reader（缓冲到 \n 边界）
- JSON 帧解析
- 权限请求/响应队列（pendingRequests Map）
- control_request → 等待 response 的配对机制
- prependUserMessage()：在消息流中注入 user message
- processLine()：解析一行 JSON 并路由

### 消息渲染

**参考**: `src/components/Message.tsx` (626 行) + `Messages.tsx` (833 行) + `MessageRow.tsx` (382 行)

这些是 Ink（终端 React）组件，Web UI 需要用 HTML/CSS 重实现，但**渲染逻辑**可参考：
- assistant message：Markdown 文本 + thinking 折叠 + 工具调用
- tool_use：参数展示（Bash 命令、文件路径）
- tool_result：折叠/展开长输出
- system message：状态提示

### 权限审批 UI

**参考**: `src/components/permissions/PermissionRequest.tsx` (216 行)

包含的逻辑（重实现为 HTML）：
- 工具名 + 参数展示
- allow / deny 按钮
- permission_suggestions 展示
- 危险操作高亮

### Markdown 渲染

**参考**: `src/components/Markdown.tsx` + `MarkdownTable.tsx`

Ink 版 Markdown 渲染。Web 版直接用 `marked` + `highlight.js`（都已在 rdcc 的 package.json 里）。

### Diff 渲染

**参考**: `packages/color-diff-napi/src/index.ts` (1006 行)

完整的语法高亮 diff 渲染，纯 TypeScript 实现。Web UI 可以直接复用或用 `diff2html` 库替代。

## 不参考的代码（Anthropic 专有）

以下文件的逻辑不复用，替换为自建实现：

| 文件 | 原因 |
|------|------|
| `src/bridge/trustedDevice.ts` | Anthropic 设备注册 |
| `src/bridge/jwtUtils.ts` | Anthropic JWT 解析（sk-ant-si- 前缀） |
| `src/bridge/workSecret.ts` | Anthropic 工作密钥 |
| `src/bridge/codeSessionApi.ts` | Anthropic /v1/code/sessions API |
| `src/bridge/bridgeEnabled.ts` | isClaudeAISubscriber() 检查 |
| `src/services/oauth/*` | Anthropic OAuth 流程 |
| `src/constants/oauth.ts` | Anthropic OAuth 端点配置 |

## 复用统计

| 分类 | 可复用行数 | 需替换行数 | 说明 |
|------|-----------|-----------|------|
| bridge 参考 | ~3,600 | ~960 (auth 层) | 消息/传输/UI/权限全复用 |
| relay 参考 | ~910 | 全部（Go 重写） | 参考接口设计，Go 实现 |
| web 参考 | ~2,700 | 全部（React 重实现） | 参考逻辑，HTML/CSS 重做 |
| **总计** | **~7,200 行参考** | | |
