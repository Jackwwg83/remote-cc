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
  → Body: { sessionId?: string, cwd?: string }
  → sessionId 有值 → spawn claude --print --resume <id>（从 cwd 启动）
  → sessionId 为空 → spawn 新会话（用 cwd 或默认 bridge cwd）
  → 返回: { ok: true, sessionId: string }
  → 409 Conflict: 如果已有进程在 spawning/running

GET /sessions/status
  → 返回: { state: 'idle' | 'spawning' | 'running', sessionId?: string }

POST /sessions/stop
  → 停止当前 claude 进程
  → 返回: { ok: true }
```

### 数据流
```
手机打开 Web UI
  ↓
WebSocket 连接建立
  ↓
App.tsx 收到 bridge 状态消息？
  ├── state: 'running' → 直接进入对话界面（已有活跃 claude 进程）
  └── state: 'idle' / 'waiting_for_session' → 显示 SessionPicker
              ↓
        GET /sessions/history → bridge 扫描本地 .jsonl（排除 subagent）
              ↓
        显示 session 列表（项目名 | 时间 | 摘要）
        + "New Session" 按钮
              ↓
        用户选择一个 session（或 new）
              ↓
        POST /sessions/start { sessionId: "xxx", cwd: "/path/to/project" }
              ↓
        bridge 检查进程状态：idle → spawn；spawning/running → 409
              ↓
        spawn claude --print --resume <id>（cwd 设为 session 对应目录）
              ↓
        WebSocket 开始转发 → 进入对话界面

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
- **排除 subagent session**：读前 10 行，如果包含 `"parentSessionId"` 字段则跳过
- 可选：只扫描当前 cwd 对应的 project 目录（减少扫描范围）
- 返回 JSON API 格式

```typescript
interface SessionInfo {
  id: string           // 完整 UUID（claude --resume 需要完整 ID）
  shortId: string      // first4..last4（UI 显示用）
  project: string      // 项目名（cwd basename）
  cwd: string          // 完整工作目录（spawn 时需要设为 cwd）
  time: string         // ISO 时间戳（文件 mtime）
  summary: string      // 第一条 user message，截断 120 字符
  isSubagent: false    // 已过滤，始终 false
}

async function scanSessions(projectDir?: string): Promise<SessionInfo[]>
```

### subagent 过滤策略
1. 主过滤：读前 10 行，检查是否有 `"parentSessionId"` 字段
2. 备选过滤：文件大小 < 1KB 的 .jsonl 大概率是 subagent 空壳（辅助参考，不作主判断）

## Task 列表 (≤ 15)

### bridge 端
- [ ] T-F01: sessionScanner.ts — 扫描 ~/.claude/projects/ 返回 SessionInfo[]，排除 subagent（parentSessionId 检测）— 验收: 能列出本机所有主 session，不含 subagent
- [ ] T-F02: httpServer.ts 新增 GET /sessions/history — 验收: curl 返回 session JSON 列表（按时间倒序，不含 subagent）
- [ ] T-F03: spawner.ts 支持 --resume / --continue + cwd 参数 — 验收: spawnClaude({mode: 'resume', sessionId, cwd}) 能从正确目录恢复会话
- [ ] T-F04: spawner.ts 进程状态管理 — idle/spawning/running/stopping 状态机，防并发 spawn — 验收: 连续两次 spawn 请求第二次返回 409
- [ ] T-F05: httpServer.ts 新增 POST /sessions/start + GET /sessions/status + POST /sessions/stop — 验收: curl POST 触发 spawn，状态查询正确，stop 能终止进程
- [ ] T-F06: index.ts 改造启动流程 — bridge 启动不自动 spawn，WebSocket 发 waiting_for_session 状态 — 验收: bridge 启动后 ws 连接收到状态消息
- [ ] T-F07: index.ts CLI 参数 --continue / --resume — 验收: remote-cc --continue 先扫描找 cwd 再恢复最近会话
- [ ] T-F08: sessionScanner.test.ts — 验收: 测试覆盖扫描、subagent 过滤、排序、cwd 解析

### web 端
- [ ] T-F09: SessionPicker.tsx — 会话选择界面 — 验收: 显示 session 列表 + New Session 按钮，每条显示项目名/时间/摘要
- [ ] T-F10: App.tsx 集成 SessionPicker — 根据 bridge 状态消息决定显示 SessionPicker 或对话界面 — 验收: idle 时显示选择，running 时显示对话
- [ ] T-F11: session 选中后 POST /sessions/start（含 cwd）→ 等待 spawn → 进入对话 — 验收: 完整链路跑通

### 端到端
- [ ] T-F12: E2E 测试 — 验收: 手机打开 → 看到 session 列表 → 选择 → 恢复对话 → 发新消息 → 结束后回到列表

## 验证标准
- [ ] 手机打开 web UI → 显示 session 列表（至少显示最近 10 个 sessions）
- [ ] 选择已有 session → 恢复对话历史（能看到之前的消息）
- [ ] 选择 "New Session" → 新的空白对话
- [ ] bridge --continue → 不显示选择界面，直接恢复最近 session
- [ ] 对话结束后 → 回到选择界面（可选）
- [ ] 全部测试通过
- [ ] .track/TASKS.md / PROGRESS.md 已更新

## Spike 验证结果（2026-04-04）

### `claude --print --continue` 在 stream-json 模式下可用 ✅
```bash
cd /Users/jackwu/ruidongcc  # 必须从正确的 cwd 启动
claude --print --continue \
  --input-format stream-json --output-format stream-json \
  --verbose --max-turns 1
```
输出确认：
- `hook_name: "SessionStart:resume"` → 走的是 resume 路径
- `session_id: "6ff26c3c-..."` → 正确恢复了最近 session
- 完整的 stream-json 协议输出（system.init → assistant partial → assistant complete）

### 关键发现
1. **cwd 是 session 查找的 key**：`~/.claude/projects/{cwd-hash}/` 是按工作目录哈希分组的。spawn claude 时 **必须** 设置正确的 cwd，否则找不到 session 文件
2. **`--continue` 自动恢复最近 session**：不需要手动指定 session ID，Claude CLI 自己找最近的
3. **`--resume <id>` 需要完整 UUID**：不是 short ID
4. **subagent sessions 混在一起**：`~/.claude/projects/{hash}/` 下既有主 session 也有 subagent session（通常文件较小），scanner 需要过滤

## Codex Review 反馈（第一轮：NEEDS_WORK）

### 已采纳的修改

1. **Scanner 排除 subagent session**
   - 问题：subagent 产生的 .jsonl 文件也在同一目录下，会污染 session 列表
   - 方案：scanner 检查 .jsonl 前 10 行，如果包含 `"parentSessionId"` 字段则跳过
   - 备选：按文件大小过滤（subagent session 通常很小），但不够可靠

2. **POST /sessions/start 需要 cwd 参数**
   - 问题：原计划 POST body 只有 `sessionId`，但 spawn claude 需要正确的 cwd
   - 方案：`POST /sessions/start { sessionId?: string, cwd?: string }`
   - 新 session 时 cwd 可选（默认用 bridge 启动时的 cwd）
   - 恢复 session 时从 scanner 缓存的 SessionInfo.cwd 获取

3. **并发 spawn 保护（Process Manager）**
   - 问题：用户快速点击可能触发多次 POST /sessions/start，spawn 多个 claude 进程
   - 方案：新增 processManager 层，维护当前进程状态
     - `state: 'idle' | 'spawning' | 'running' | 'stopping'`
     - `spawning` 状态下拒绝新的 spawn 请求（409 Conflict）
     - `running` 状态下拒绝（需要先 stop 当前 session）
   - 放在 spawner.ts 内部实现，不新增文件

4. **Bridge 启动流程明确化**
   - 问题：原计划说"bridge 启动后不自动 spawn，等 web 选择"，但没说清楚 WebSocket 连接怎么处理
   - 方案：
     - bridge 启动 → HTTP server + WebSocket server 就绪
     - WebSocket 连接建立 → 发送 `{"type": "system", "subtype": "waiting_for_session"}` 状态消息
     - 收到 POST /sessions/start → spawn claude → 开始转发
     - Web UI 收到 `waiting_for_session` → 显示 SessionPicker

5. **`--resume` 参数的 cwd 处理**
   - 问题：bridge CLI `--resume <id>` 需要知道对应 session 的 cwd
   - 方案：先扫描本地 sessions 找到该 ID 的 cwd，再 spawn。找不到则报错退出

## 预估风险
- **scanner 性能**：项目多时扫描可能慢 → 应对：只读前 10 行提取元数据，文件级并行扫描
- **session 恢复失败**：.jsonl 文件损坏或 session 状态不一致 → 应对：resume 失败时 fallback 到新 session
- **启动流程变更**：现在 bridge 启动就 spawn claude，改成等选择 → 需要处理好"无活跃进程"状态
- **cwd 不匹配**：如果项目目录被移动/重命名，session 无法恢复 → 应对：UI 提示"原目录不存在"，建议新建 session
- **subagent 泄漏**：scanner 如果没过滤好，列表会充满 subagent 碎片 → 应对：`parentSessionId` 检测 + 文件大小双重过滤
