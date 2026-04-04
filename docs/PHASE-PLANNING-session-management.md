# Phase: Session 管理 + 会话列表 `[待开始]`

## 一句话目标
用户在手机 Web UI 上能看到本地所有 Claude Code 会话列表，选择恢复已有会话或创建新会话，bridge 用 `claude --print --resume <id>` 恢复。

## 优先级排序
1. **必须完成**:
   - bridge 端 session scanner（扫描 ~/.claude/projects/ 下的 .jsonl 文件）
   - bridge 暴露 `GET /sessions/history` API（返回 session 列表）
   - bridge 支持 `--continue` / `--resume <id>` CLI 参数
   - web UI 启动时显示 session 选择界面（列表 + 新建按钮）
   - 选中 session 后 bridge 用 `claude --print --resume <id>` spawn

2. **尽量完成**:
   - 会话列表显示 session 摘要（第一条 user message）
   - 会话列表按时间排序（最近的在前）
   - 当前 session 结束后回到选择界面
   - bridge CLI `--continue` 自动恢复最近的 session

3. **如果有时间**:
   - 按项目分组显示 sessions
   - session 搜索/过滤
   - 显示 session 消息数量和 token 消耗

## 影响分析

### 涉及的边界
- [x] 跨进程/服务边界 → bridge (Node.js) ↔ web (React) 通过 HTTP API + WebSocket
- [x] 改动外部接口/协议 → 新增 `GET /sessions/history` HTTP 端点；spawner 新增 `--resume`/`--continue` 参数
- [ ] 影响多个状态源 → 否

### 回归风险区
- 改动 spawner.ts → 可能影响现有的 claude spawn + initialize 流程
- 改动 httpServer.ts → 可能影响现有的 /health、/ 路由
- 改动 App.tsx → 可能影响现有的对话界面

### 安全影响
- [x] 涉及用户数据 → 扫描 ~/.claude/projects/ 读取 session 文件（只读）
- [ ] 涉及外部输入验证 → session ID 来自本地文件名（UUID），不需要特殊校验
- [ ] 涉及进程权限变更 → 否

## 架构变更评估

### 新增模块/文件
```
bridge/src/sessionScanner.ts    — 扫描 ~/.claude/projects/ 读取 session 列表
                                   参考 vibesession 的 scanner/claude.go
web/src/SessionPicker.tsx       — 会话选择界面（session 列表 + 新建按钮）
```

### 修改模块/文件
```
bridge/src/spawner.ts           — CLAUDE_ARGS 新增 --resume / --continue 支持
bridge/src/httpServer.ts        — 新增 GET /sessions/history 路由
bridge/src/index.ts             — CLI 参数新增 --continue / --resume
                                   启动流程改为：先选 session → 再 spawn
web/src/App.tsx                 — 启动时先显示 SessionPicker，选中后进入对话
```

### API 变更
```
GET /sessions/history
  → 返回: { sessions: [{ id, shortId, project, cwd, time, summary }] }
  → 按 time 倒序
  → 来自 ~/.claude/projects/{cwd-hash}/*.jsonl

POST /sessions/start
  → Body: { sessionId?: string }
  → sessionId 有值 → spawn claude --print --resume <id>
  → sessionId 为空 → spawn 新会话
  → 返回: { ok: true, sessionId: string }
```

### 数据流
```
手机打开 Web UI
  ↓
App.tsx 检查：有没有活跃的 claude 进程？
  ├── 有 → 直接进入对话界面（现有逻辑）
  └── 没有 → 显示 SessionPicker
              ↓
        GET /sessions/history → bridge 扫描本地 .jsonl
              ↓
        显示 session 列表（项目名 | 时间 | 摘要）
        + "New Session" 按钮
              ↓
        用户选择一个 session（或 new）
              ↓
        POST /sessions/start { sessionId: "xxx" 或 null }
              ↓
        bridge spawn claude --print --resume <id>（或不带 --resume）
              ↓
        WebSocket 连接建立 → 进入对话界面

### SessionPicker UI 设计
```
┌─────────────────────────────────────┐
│  remote-cc           🌙  v0.1.0    │
├─────────────────────────────────────┤
│                                      │
│  Select a session                    │
│                                      │
│  ┌─ New Session ──────────────────┐  │
│  │  🆕 Start a fresh conversation │  │
│  └────────────────────────────────┘  │
│                                      │
│  Recent sessions                     │
│                                      │
│  ┌─ remote-cc ────── 2 min ago ──┐  │
│  │  Create a tetris game...       │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌─ rdcc ──────────── 1 hour ago ┐  │
│  │  Fix the build script...       │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌─ my-project ────── 3 hours ago┐  │
│  │  Add user authentication...    │  │
│  └────────────────────────────────┘  │
│                                      │
└─────────────────────────────────────┘
```

## Session Scanner 设计（参考 vibesession）

vibesession 的 scanner/claude.go 做的：
1. 遍历 `~/.claude/projects/` 下所有目录
2. 每个目录下扫描 `*.jsonl` 文件
3. 读前 10 行找 `sessionId` 和 `cwd`
4. 找第一条 `type: "user"` 消息作为摘要
5. 用文件 mtime 作为时间戳

我们的 sessionScanner.ts 做同样的事，但：
- 用 TypeScript 实现（不是 Go）
- 可选：只扫描当前 cwd 对应的 project 目录（减少扫描范围）
- 返回 JSON API 格式

```typescript
interface SessionInfo {
  id: string           // 完整 UUID
  shortId: string      // first4..last4
  project: string      // 项目名（cwd basename）
  cwd: string          // 完整工作目录
  time: string         // ISO 时间戳（文件 mtime）
  summary: string      // 第一条 user message，截断 120 字符
}

async function scanSessions(projectDir?: string): Promise<SessionInfo[]>
```

## Task 列表 (≤ 15)

### bridge 端
- [ ] T-F01: sessionScanner.ts — 扫描 ~/.claude/projects/ 返回 SessionInfo[]（参考 vibesession scanner/claude.go）— 验收: 能列出本机所有 claude sessions
- [ ] T-F02: httpServer.ts 新增 GET /sessions/history — 验收: curl 返回 session JSON 列表
- [ ] T-F03: spawner.ts 支持 --resume / --continue — 验收: spawnClaude('resume', sessionId) 能恢复会话
- [ ] T-F04: httpServer.ts 新增 POST /sessions/start — 验收: curl POST 触发 spawn
- [ ] T-F05: index.ts 改造启动流程 — 验收: bridge 启动后不自动 spawn，等 web 选择
- [ ] T-F06: index.ts CLI 参数 --continue / --resume — 验收: remote-cc --continue 直接恢复最近会话
- [ ] T-F07: sessionScanner.test.ts — 验收: 测试覆盖扫描、解析、排序

### web 端
- [ ] T-F08: SessionPicker.tsx — 会话选择界面 — 验收: 显示 session 列表 + New Session 按钮
- [ ] T-F09: App.tsx 集成 SessionPicker — 验收: 启动时显示选择界面，选中后进入对话
- [ ] T-F10: session 选中后 POST /sessions/start → WebSocket 连接 — 验收: 完整链路跑通

### 端到端
- [ ] T-F11: E2E 测试 — 验收: 手机打开 → 看到 session 列表 → 选择 → 恢复对话 → 发新消息

## 验证标准
- [ ] 手机打开 web UI → 显示 session 列表（至少显示最近 10 个 sessions）
- [ ] 选择已有 session → 恢复对话历史（能看到之前的消息）
- [ ] 选择 "New Session" → 新的空白对话
- [ ] bridge --continue → 不显示选择界面，直接恢复最近 session
- [ ] 对话结束后 → 回到选择界面（可选）
- [ ] 全部测试通过
- [ ] .track/TASKS.md / PROGRESS.md 已更新

## 预估风险
- **scanner 性能**：项目多时扫描可能慢 → 应对：只读前 10 行提取元数据，文件级并行扫描
- **session 恢复失败**：.jsonl 文件损坏或 session 状态不一致 → 应对：resume 失败时 fallback 到新 session
- **启动流程变更**：现在 bridge 启动就 spawn claude，改成等选择 → 需要处理好"无活跃进程"状态
