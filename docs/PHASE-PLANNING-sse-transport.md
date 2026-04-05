# Phase: SSE + POST 传输层重构 `[待开始]`

## 一句话目标
将 remote-cc 的传输层从 WebSocket 改为 SSE（下行）+ HTTP POST（上行），参考 Claude Code v2 架构，解决手机端连接不稳定的核心痛点。

## 背景与动机
当前 WebSocket 传输在手机上频繁断连：
- iOS/Android 锁屏后 WebSocket 静默断开，无原生重连机制
- 我们的手写重连（2s backoff × 5）不够健壮
- Claude Code 官方已从 WebSocket 迁移到 SSE + POST（v2 架构），经生产验证

SSE 的浏览器 EventSource API 内置自动重连 + `Last-Event-ID` 续传，是移动端最稳定的流式传输方案。

## 优先级排序

1. **必须完成**:
   - bridge 端 SSE endpoint（替代 WebSocket broadcast）
   - bridge 端 POST /messages endpoint（替代 WebSocket onMessage）
   - bridge 端 keepalive 心跳（15s 间隔）
   - web 端 EventSource 客户端（替代 ws.ts）
   - web 端 fetch POST 发消息（替代 ws.send）
   - seq 续传（Last-Event-ID / from_seq 查询参数）
   - 现有功能不回归（session picker、permission dialog 等）

2. **尽量完成**:
   - liveness timeout（45s 无心跳 → 重连）
   - 指数退避 + jitter（1s→30s，10 分钟总预算）
   - 连接状态 UI 适配（connecting/connected/reconnecting/disconnected）

3. **如果有时间**:
   - stream_event 批量合并（100ms 窗口，减少 POST 次数）
   - 笔记本休眠唤醒检测（间隔 >60s 重置重连预算）

## 影响分析

### 涉及的边界
- [x] 跨进程/服务边界 → bridge (Node.js) ↔ web (React) 通过 SSE + HTTP POST
- [x] 改动外部接口/协议 → 新增 `GET /events/stream`（SSE）和 `POST /messages`，替代 WebSocket
- [x] 影响多个状态源 → 连接状态管理从 WS 事件切换到 SSE 事件

### 回归风险区
- 改动 index.ts → 整个 bridge loop 的消息转发方式改变
- 删除 wsServer.ts → 所有依赖它的模块需要适配
- 改动 web/src/ws.ts → App.tsx、SessionPicker 的连接逻辑全部受影响
- 改动 httpServer.ts → 新增 SSE 和 POST 路由

### 安全影响
- [x] 涉及外部输入验证 → POST /messages 需要 token 认证
- SSE endpoint 需要 token 认证（query param，因为 EventSource 不支持自定义 header）

## 架构变更评估

### 核心设计（参考 Claude Code v2）

```
┌─────────────────────────┐
│     Web UI (React)      │
│                         │
│  EventSource            │  ← SSE 下行（claude stdout → 浏览器）
│  GET /events/stream     │     自动重连 + Last-Event-ID 续传
│  ?token=xxx             │     seq envelope: id + event + data
│  &from_seq=N            │
│                         │
│  fetch POST             │  ← HTTP POST 上行（用户输入 → claude stdin）
│  POST /messages         │     每条消息独立 POST
│  Authorization: Bearer  │     JSON body
│                         │
└─────────┬───────────────┘
          │
          ▼
┌─────────────────────────┐
│   Bridge (Node.js)      │
│                         │
│  SSE Writer             │  ← 管理 SSE 连接，发送 seq 消息 + keepalive
│  - clients: Set<Res>    │     response.write() 流式输出
│  - keepalive: 15s       │     格式: id:{seq}\nevent:message\ndata:{json}\n\n
│  - liveness: per-client │
│                         │
│  POST Handler           │  ← 接收用户消息，转发到 claude stdin
│  - auth check           │     writeLine(proc.stdin, parsed)
│  - JSON parse           │
│                         │
│  Message Cache          │  ← 复用现有 messageCache.ts
│  - replay on reconnect  │     from_seq → 发送 missed messages
│  - 200 条环形缓冲      │
│                         │
└─────────────────────────┘
```

### SSE 帧格式

```
下行消息（claude stdout → client）:
id:42
event:message
data:{"type":"assistant","message":{"role":"assistant","content":[...]}}

心跳（每 15 秒）:
:keepalive

session 状态:
event:session_status
data:{"state":"waiting_for_session"}

event:session_status
data:{"state":"running"}
```

### 新增模块/文件
```
bridge/src/sseWriter.ts        — SSE 连接管理器（替代 wsServer.ts）
web/src/transport.ts           — SSE + POST 客户端（替代 ws.ts）
```

### 修改模块/文件
```
bridge/src/httpServer.ts       — 新增 GET /events/stream（SSE）和 POST /messages
bridge/src/index.ts            — wireSession() 改用 sseWriter 替代 ws
web/src/App.tsx                — 连接逻辑从 connectWs → connectTransport
```

### 保留不变
```
bridge/src/messageCache.ts     — 完全复用（push/replayWithSeq/clear）
bridge/src/auth.ts             — 复用 token 生成，认证逻辑迁到 HTTP 层
bridge/src/spawner.ts          — 不变
bridge/src/processManager.ts   — 不变
bridge/src/sessionScanner.ts   — 不变
bridge/src/lineReader.ts       — 不变
bridge/src/initializer.ts      — 不变
web/src/SessionPicker.tsx      — 不变（已用 fetch，不依赖 WS）
web/src/MessageRenderer.tsx    — 不变
web/src/PermissionDialog.tsx   — 不变
web/src/streamingState.ts      — 不变
```

### 删除模块/文件
```
bridge/src/wsServer.ts         — 被 sseWriter.ts 替代
web/src/ws.ts                  — 被 transport.ts 替代
```

## API 变更

### 新增端点

```
GET /events/stream
  认证: ?token=xxx（EventSource 不支持自定义 header）
  查询参数: ?from_seq=N（可选，续传起点）
  响应: Content-Type: text/event-stream
  帧格式:
    id:{seq}\nevent:message\ndata:{json}\n\n     — 普通消息
    :keepalive\n\n                                — 心跳（15s）
    event:session_status\ndata:{json}\n\n         — 状态变更

POST /messages
  认证: Authorization: Bearer <token>
  Content-Type: application/json
  Body: { type: "user", message: { role: "user", content: "..." }, ... }
  响应: { ok: true }
  错误: 401 Unauthorized / 503 No active session
```

### 删除端点
```
WebSocket upgrade（ws://host:port） — 整个 WebSocket 通道移除
```

## sseWriter 设计

```typescript
export interface SseWriter {
  /** 发送一条带 seq 的消息给所有连接的客户端 */
  broadcast(seq: number, data: string): void
  /** 发送 session_status 事件（无 seq） */
  broadcastStatus(state: string, extra?: Record<string, unknown>): void
  /** 当前连接的客户端数 */
  clientCount(): number
  /** 关闭所有连接 */
  close(): void
}

export interface SseWriterDeps {
  /** 认证 token */
  authToken?: string
  /** 消息缓存，用于新连接的 replay */
  messageCache: MessageCache
  /** 获取当前 session 状态，新连接时立即发送（解决 Codex #3） */
  getSessionState: () => { state: string; [key: string]: unknown }
}

/**
 * 创建 SSE 请求处理器（挂到 httpServer 的路由上）
 * 不是独立 server — 是 handleRequest 的一个分支
 */
export function createSseWriter(deps: SseWriterDeps): {
  writer: SseWriter
  /** HTTP 请求处理器，匹配 GET /events/stream */
  handleSseRequest: (req: IncomingMessage, res: ServerResponse) => void
}
```

### 实现要点
1. **客户端跟踪**：`Set<ServerResponse>` — 每个 SSE 连接就是一个 HTTP response 对象
2. **连接建立**：设置 `Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`、`X-Accel-Buffering: no`（防代理缓冲）
3. **认证**：从 `?token=xxx` 查询参数提取，和现有 `checkAuth` 逻辑一致
4. **seq 来源统一（Codex #1）**：优先检查 `Last-Event-ID` header（浏览器重连自动带），fallback 到 `?from_seq=N` 查询参数（首次连接时客户端手动传）。两者取较大值。
5. **连接时立即发送 session state（Codex #3）**：调用 `deps.getSessionState()` 获取当前状态，写入 `event:session_status\ndata:{...}\n\n`。确保 late joiner 和重连都能恢复 UI 状态。
6. **replay**：从 seq 来源获取 fromSeq，调用 `messageCache.replayWithSeq(fromSeq)` 发送缺失消息
7. **心跳**：每 15s 向所有活跃连接发送 `:keepalive\n\n`
8. **断开检测**：监听 `res.on('close')` 移除客户端
9. **背压**：检查 `res.writableLength`，超阈值跳过（类似现有 WS 背压逻辑）

## web/src/transport.ts 设计

```typescript
export type TransportState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

export interface ReconnectMeta {
  attempt: number
  maxAttempts: number
}

export function connectTransport(baseHttpUrl: string): {
  /** POST 发送消息，返回是否成功（Codex #4：失败时 UI 可提示） */
  send(msg: unknown): Promise<boolean>
  /** 注册消息回调 */
  onMessage(cb: (data: unknown) => void): void
  /** 注册状态变化回调 */
  onStateChange(cb: (state: TransportState, meta?: ReconnectMeta) => void): void
  /** 手动重连 */
  reconnect(): void
  /** 关闭连接 */
  close(): void
  /** 当前最新 seq */
  getLastSeq(): number
}
```

### 与现有 ws.ts 接口对比

| ws.ts | transport.ts | 变化 |
|-------|-------------|------|
| `connectWs(wsUrl)` | `connectTransport(httpUrl)` | URL 协议从 ws → http |
| `ws.send(msg)` | `transport.send(msg)` → `fetch POST /messages` | 从 WS 帧改为 HTTP POST |
| `ws.onMessage(cb)` | `transport.onMessage(cb)` | 不变，回调签名一致 |
| `ws.onStateChange(cb)` | `transport.onStateChange(cb)` | 不变 |
| `ws.onError(cb)` | 移除 | 错误合并到 onStateChange |
| `ws.reconnect()` | `transport.reconnect()` | 从 new WebSocket → new EventSource |
| `ws.close()` | `transport.close()` | EventSource.close() |
| `ws.getLastSeq()` | `transport.getLastSeq()` | 不变 |
| seq envelope unwrap | SSE frame parse | 浏览器 EventSource 自动解析 |
| manual reconnect | EventSource 原生重连 + 手动增强 | 双层重连 |

### 实现要点
1. **EventSource 连接**：`new EventSource('/events/stream?token=xxx&from_seq=N')`
2. **消息接收**：
   - `es.addEventListener('message', handler)` — 普通 claude 消息，解析 data JSON
   - `es.addEventListener('session_status', handler)` — 状态消息
3. **session_status 格式翻译（Codex #2）**：SSE `event:session_status` + `data:{state}` 在 transport.ts 内部翻译为 `{type:"system", subtype:"session_status", state}` 后传给 onMessage 回调，保持 App.tsx 不变
4. **seq 跟踪**：从 `event.lastEventId` 获取 seq（浏览器自动维护）
5. **自动重连**：EventSource 原生重连 + Last-Event-ID 自动发送
6. **手动重连增强**：原生重连失败时，自定义退避（参考 Claude v2: 1s→30s, 10min budget）
7. **POST 发送**：`fetch('/messages', { method: 'POST', headers: { Authorization, Content-Type }, body })` — 返回 Promise<boolean>，失败时 retry 1 次
8. **navigator.onLine**：监听网络恢复，立即重连

### 重连策略（参考 Claude Code SSETransport）
```
Layer 1: EventSource 原生重连（浏览器自动）
  - 浏览器默认 ~3s 间隔
  - 自动携带 Last-Event-ID header
  - 对于大多数短暂断连已够用

Layer 2: 手动增强（当原生重连失败或超时）
  - 45s liveness timeout：无心跳 → 关闭 EventSource → 手动重建
  - 指数退避：1s base, 30s max, ±25% jitter
  - 10 分钟总预算：超时 → disconnected 状态
  - navigator.onLine：网络恢复 → 立即重连，重置预算
```

## 数据流

```
用户在手机输入消息
  ↓
fetch POST /messages { type: "user", message: { content: "hi" } }
  → bridge auth check
  → JSON parse
  → writeLine(proc.stdin, parsed)
  ↓
claude 处理...
  ↓
claude stdout → lineReader → seq++ → cache.push()
  ↓
sseWriter.broadcast(seq, rawJson)
  → 所有 SSE 连接: write("id:42\nevent:message\ndata:{json}\n\n")
  ↓
浏览器 EventSource onmessage
  → lastEventId = "42"
  → parse data JSON
  → onMessage callback → App.tsx 更新 UI

--- 断连恢复 ---

手机锁屏/WiFi 断开
  → EventSource 自动断开
  → bridge 检测 res.on('close') → 移除客户端
  ↓
手机解锁/WiFi 恢复
  → EventSource 自动重连: GET /events/stream?token=xxx
    → 浏览器自动发送 Last-Event-ID: 42
  → bridge 解析 Last-Event-ID → cache.replayWithSeq(42) → 发送 missed messages
  → 无缝续传，用户无感知
```

## Task 列表 (≤ 15)

### bridge 端
- [ ] T-S01: sseWriter.ts — SSE 连接管理器 + keepalive 心跳 — 验收: 能建立 SSE 连接，收到心跳帧
- [ ] T-S02: httpServer.ts 新增 GET /events/stream — 验收: curl --no-buffer 收到 SSE 流
- [ ] T-S03: httpServer.ts 新增 POST /messages — 验收: curl POST 消息能转发到 claude stdin
- [ ] T-S04: index.ts 重构 — 从 wsServer 切换到 sseWriter — 验收: bridge 启动不依赖 wsServer
- [ ] T-S05: 删除 wsServer.ts — 验收: 构建通过，无 import 残留
- [ ] T-S06: sseWriter.test.ts — 验收: 覆盖连接、广播、心跳、replay、断开

### web 端
- [ ] T-S07: transport.ts — SSE + POST 客户端（替代 ws.ts）— 验收: 能连接、收消息、发消息、自动重连
- [ ] T-S08: App.tsx 切换 — 从 connectWs → connectTransport — 验收: 所有现有功能不回归
- [ ] T-S09: 删除 ws.ts — 验收: 构建通过，无 import 残留

### 端到端
- [ ] T-S10: 集成测试 — 验收: bridge → SSE → 浏览器，POST → bridge → claude，完整对话流程
- [ ] T-S11: 重连测试 — 验收: 模拟断连后自动恢复，消息不丢失
- [ ] T-S12: E2E 浏览器测试 — 验收: 手机打开 → SessionPicker → 选择 → 对话 → 回复正常

## 验证标准
- [ ] `npm run build` 成功（bridge + web）
- [ ] 212 个现有 bridge 测试不回归（wsServer 测试替换为 sseWriter 测试）
- [ ] 手机打开 web UI → SessionPicker → 选择 session → 对话正常
- [ ] 锁屏 5s → 解锁 → 自动恢复连接，消息不丢失
- [ ] curl 测试 SSE 流: `curl -N 'http://localhost:7860/events/stream?token=xxx'`
- [ ] curl 测试 POST: `curl -X POST ... /messages`
- [ ] 全部测试通过
- [ ] .track/TASKS.md / PROGRESS.md 已更新

## Codex Review 反馈

### 第一轮修改（4 项）

1. **Last-Event-ID vs from_seq 统一**
   - bridge 优先读 `Last-Event-ID` header（重连时浏览器自动带），fallback 到 `?from_seq=N`（首次连接），取较大值

2. **session_status 格式兼容**
   - transport.ts 翻译 SSE `event:session_status` → `{type:"system", subtype:"session_status", state}` 再传给 onMessage 回调，App.tsx 零改动

3. **连接时立即发送 session state**
   - sseWriter deps 新增 `getSessionState()` 回调，新连接时立即发送状态

4. **send() 返回 Promise**
   - `send(msg): Promise<boolean>` — 失败时 App.tsx 可提示

### 第二轮修改（4 项）

5. **session_ended 重连恢复路径**
   - `session_ended` 是瞬态过渡事件，紧接着会发 `waiting_for_session`。如果客户端恰好在这两个事件之间断连，重连后 `getSessionState()` 返回 `waiting_for_session`（因为 session 已结束），UI 正确回到 picker。无需单独处理 session_ended 的持久化。
   - transport.ts 内部在收到 `session_ended` 时清空 lastSeq（新 session 的 seq 从 0 开始），避免下次重连请求旧 seq。

6. **httpServer handler 注册契约**
   - HttpServerDeps 新增字段：
     ```typescript
     export interface HttpServerDeps {
       // ... 现有字段 ...
       /** SSE writer 的请求处理器 */
       sseHandler?: (req: IncomingMessage, res: ServerResponse) => void
       /** POST /messages 的消息回调，返回 false 表示无活跃 session（→ 503） */
       onMessageReceived?: (msg: Record<string, unknown>) => boolean
     }
     ```
   - httpServer.ts 路由使用 `new URL(req.url, base).pathname` 匹配（不是 raw `req.url` 字符串比较，因为带 query params）
   - `pathname === '/events/stream'` 时调用 `deps.sseHandler(req, res)`
   - `pathname === '/messages'` 时：auth check → JSON parse → `const ok = deps.onMessageReceived(parsed)` → ok ? 200 : 503
   - index.ts 在创建 sseWriter 后，将 handler 传入 httpServer deps

7. **token 传递和初始状态 emit**
   - `connectTransport(baseHttpUrl)` 从 URL 的 `?token=xxx` 提取 token
   - EventSource URL: `${origin}/events/stream?token=${token}&from_seq=${lastSeq}`
   - fetch POST header: `Authorization: Bearer ${token}`
   - 连接后 `onStateChange` 立即 emit 当前状态（和 ws.ts 行为一致，在 `onStateChange` 注册时立即回调）

8. **POST retry 幂等保护**
   - 客户端为每条消息生成 `_messageId`（UUID v4），附在 POST body 中
   - bridge 端维护 `recentMessageIds: Set<string>`（最近 100 条，5 分钟过期）
   - 重复 `_messageId` 的 POST → 200 OK 但不转发（静默去重）
   - 这和 Claude Code 的 `BoundedUUIDSet` 去重模式一致

## 预估风险
- **EventSource 不支持自定义 header**：认证只能通过 query param `?token=xxx` → 已接受，和 WS 方案一致
- **SSE 连接被中间代理缓冲**：某些反向代理（nginx）会缓冲 SSE 响应 → 应对: 设置 `X-Accel-Buffering: no` header
- **POST 失败时消息丢失**：用户消息 POST 如果网络断开会丢失 → 应对: 客户端 retry 1 次，失败时 UI 提示
- **迁移期兼容性**：一步切换，不做 WS/SSE 双协议共存 → 简化实现，但 web 必须和 bridge 同时更新
