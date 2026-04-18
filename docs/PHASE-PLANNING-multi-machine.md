---
type: design
project: remote-cc
date: 2026-04-18
status: draft-v3
tags: [multi-machine, dashboard, ux-upgrade, architecture, client-server]
supersedes: design-multi-machine-v1.md
---

# remote-cc v2: 多机 AI 管理中心

## 一句话

多台 Mac 上的所有 Claude Code / Codex session 统一管理，Web UI 体验接近原生 CLI。

## 两个核心目标

**目标 1: 统一 Session 管理**
所有机器上的所有 session 在一个界面里管理。查看、启动、停止、恢复、迁移到其他机器。手机和电脑都能用。

**目标 2: 接近原生体验**
Web UI 的消息渲染、工具调用展示、交互能力接近本地 `claude` CLI。缩小"远程"和"本地"的体验差距。

---

## 架构: Client-Server

```
┌─────────────────────────────────────────────────────────┐
│                                                          │
│  Mac Mini A (always-on, Server 角色)                      │
│  ┌────────────────────────────────────────┐              │
│  │ remote-cc Server                       │              │
│  │                                        │              │
│  │  自己的 bridge (管本机 CC/Codex)        │              │
│  │  + Cluster Manager:                    │              │
│  │    - 接收 client 心跳                   │              │
│  │    - 缓存所有机器状态 + session 列表     │              │
│  │    - 代理请求到其他机器                  │              │
│  │    - SSE 代理 (backup)                  │              │
│  │  + Web UI: Dashboard + 完整对话         │              │
│  │                                        │              │
│  └────────────────────────────────────────┘              │
│         ↑ heartbeat         ↑ heartbeat                  │
│         │                   │                            │
│  ┌──────┴──────┐    ┌──────┴──────┐                     │
│  │ MacBook     │    │ Mac Mini B  │                     │
│  │ (Client)    │    │ (Client)    │                     │
│  │             │    │             │                     │
│  │ bridge      │    │ bridge      │                     │
│  │ + 心跳上报   │    │ + 心跳上报   │                     │
│  │ + 本机 CC   │    │ + 本机 CC   │                     │
│  └─────────────┘    └─────────────┘                     │
│                                                          │
│  Cloudflare Mesh (所有设备互通)                            │
│                                                          │
│  ┌──────────┐   ┌──────────┐                            │
│  │ iPhone   │   │ Android  │                            │
│  │          │   │          │                            │
│  │ 只连 Server (Mac Mini A)                              │
│  │ Dashboard + 对话 + 管理                               │
│  └──────────┘   └──────────┘                            │
└─────────────────────────────────────────────────────────┘
```

### 角色区分

| | Server (一台) | Client (N 台) |
|---|---|---|
| **自己的 bridge** | ✅ 管本机 CC | ✅ 管本机 CC |
| **心跳上报** | 不需要 (自己就是 server) | ✅ 每 30s POST /cluster/heartbeat |
| **存全局状态** | ✅ 缓存所有机器状态 | ❌ |
| **服务 Web UI** | ✅ Dashboard + 对话 | ✅ (也能当入口，但通常不用) |
| **代理请求** | ✅ 帮手机转发到目标 Client | ❌ |
| **接受直连** | ✅ | ✅ (手机 SSE 优先直连) |

### 认证模型

两种 token，用途不同：

| Token | 谁持有 | 用途 | 怎么传 |
|-------|--------|------|--------|
| cluster token (`rcc_cluster_xxx`) | Server 生成，Client 和手机都需要 | 访问所有 /cluster/* API | Authorization: Bearer |
| session token (`rcc_xxx`) | 每台 bridge 独立生成 | 直连某台机器的 /events/stream /messages 等 | ?token= 或 Bearer |

**完整认证流程：**

```
1. Server 启动:
   remote-cc --role server
   → 生成 cluster token: rcc_cluster_abc
   → 生成自己的 session token: rcc_server_xyz
   → 终端显示两个 token

2. Client 启动:
   remote-cc --role client --server http://mini-a:7860 --server-token rcc_cluster_abc
   → POST /cluster/register (Authorization: Bearer rcc_cluster_abc)
     body: { machineId, name, url, sessionToken: "rcc_client_xxx" }
   → Server 存下 client 的 sessionToken（代理请求时用）
   → 心跳也携带 cluster token

3. 手机连 Server:
   → 所有 /cluster/* 请求: Authorization: Bearer rcc_cluster_abc
   → 手机不需要知道各 client 的 session token（Server 代理时自动附上）

4. 手机直连某 Client (SSE 优先直连):
   → Server 在 /cluster/status 响应里返回各 client 的 sessionToken
   → 手机用该 token 直连: GET client:7860/events/stream?token=rcc_client_xxx
```

### 机器标识

每台 bridge 启动时生成 machineId (UUID)，持久化到 `~/.remote-cc/machine-id`。
machine name 是显示名，machineId 是路由 key。防止重名冲突。

### Client 心跳上报

```typescript
// 每 30 秒
POST http://server:7860/cluster/heartbeat
Authorization: Bearer rcc_cluster_abc
{
  "machineId": "uuid-xxx",
  "machineId": "uuid-macbook",
  "url": "http://100.96.0.4:7860",     // 自己的地址，让 server 知道怎么转发
  "token": "rcc_yyy",                   // 该 client 的 session token，server 代理时使用
  "status": "running",                   // idle | running | stopping
  "sessionId": "abc-123",
  "project": "remote-cc",
  "sessions": [                          // 最近 20 个 session 摘要
    {
      "id": "abc-123",
      "shortId": "abc1..c123",
      "project": "remote-cc",
      "cwd": "/Users/jackwu/ruidongcc/remote-cc",
      "time": "2026-04-18T10:30:00Z",
      "summary": "Design multi-machine architecture"
    }
  ]
}
```

Server 缓存这些数据。心跳超过 90s 没收到 → 标记 offline。

---

## 目标 1: 统一 Session 管理

### 1.1 全局 Session 列表

```
GET /cluster/sessions
GET /cluster/sessions?refresh=true   ← 实时查询所有在线 client，不用缓存

默认: 从心跳缓存读（快，可能 30s 过时）
refresh=true: fan-out 查询所有在线 client 的 /sessions/history（慢但准确）

→ 合并所有机器的 session，按时间倒序

{
  "sessions": [
    { ...session, "machineId": "uuid-macbook", "machineName": "MacBook", "machineStatus": "running" },
    { ...session, "machineId": "uuid-mini-a", "machineName": "Mac Mini A", "machineStatus": "idle" },
    { ...session, "machineId": "uuid-mini-b", "machineName": "Mac Mini B", "machineStatus": "offline" },
  ]
}
```

手机上看到的:

```
┌─────────────────────────────────────────┐
│  All Sessions                    🔍     │
├─────────────────────────────────────────┤
│                                         │
│  🟢 MacBook · remote-cc · 2 min ago    │
│  Design multi-machine architecture      │
│  [Resume] [Migrate]                    │
│                                         │
│  🟡 Mini A · rdcc · 1 hour ago         │
│  Fix build script                       │
│  [Resume] [Migrate]                    │
│                                         │
│  🟡 Mini A · awsclaw · 3 hours ago     │
│  Deploy to staging                      │
│  [Resume] [Migrate]                    │
│                                         │
│  🔴 Mini B · offline                    │
│  agentbox · 1 day ago                   │
│  [Migrate] (机器离线,只能迁移)          │
│                                         │
│  [+ New Session on ▾ MacBook]           │
└─────────────────────────────────────────┘
```

### 1.2 Session 操作

**启动/恢复 (任何机器):**
```
POST /cluster/action
{
  "machineId": "uuid-macbook",
  "action": "start_session",
  "sessionId": "abc-123"        // 可选，空=新 session
}
→ Server 转发到 MacBook 的 bridge POST /sessions/start
→ 返回结果
```

**停止:**
```
POST /cluster/action
{
  "machineId": "uuid-macbook",
  "action": "stop_session"
}
```

**查看状态:**
```
GET /cluster/status
→ {
    "machines": [
      { "machineId": "uuid-macbook", "name": "MacBook", "url": "http://100.96.0.4:7860", "sessionToken": "rcc_xxx", "status": "running", "project": "remote-cc", "lastSeen": "2s ago" },
      { "machineId": "uuid-mini-a", "name": "Mac Mini A", "url": "http://100.96.0.3:7860", "sessionToken": "rcc_yyy", "status": "idle", "lastSeen": "15s ago" },
      { "machineId": "uuid-mini-b", "name": "Mac Mini B", "url": "http://100.96.0.5:7860", "sessionToken": "rcc_zzz", "status": "offline", "lastSeen": "2h ago" }
    ]
  }

手机端用 machineId 路由操作，用 url+sessionToken 直连 SSE。
```

### 1.3 Session 迁移（冷迁移）

把一个 session 从机器 A 搬到机器 B。**冷迁移**：先停止源 session，再在目标恢复。不支持热迁移。

前置条件：
- 源机器上该 session 必须是 idle 状态（不在运行中）
- 目标机器的 cwd hash 需要和源一致（同路径的同项目）

迁移步骤会自动处理：
- 如果目标没有项目代码 → rsync 从源同步
- 如果目标没有 .jsonl 文件 → scp 从源复制

```
POST /cluster/migrate
{
  "fromMachineId": "uuid-macbook",
  "toMachineId": "uuid-mini-a",
  "sessionId": "abc-123"
}
```

Server 执行:
1. 从 MacBook 获取 session 的 .jsonl 文件路径和 cwd
2. rsync 项目代码到 Mini A (如果没有的话)
3. scp .jsonl 文件到 Mini A 的 ~/.claude/projects/{hash}/
4. 在 Mini A 上 POST /sessions/start { sessionId, cwd }
5. 返回结果

这样你可以: 白天在 MacBook 上写代码 → 晚上迁移到 Mini A 继续跑长任务 → 手机监控。

### 1.4 对话交互

手机想跟某台机器的 CC 对话:

```
优先: 直连目标机器
  SSE: http://macbook:7860/events/stream?token=xxx
  POST: http://macbook:7860/messages

回退: 通过 Server 代理 (目标机器直连不通时)
  SSE: http://server:7860/cluster/stream?machineId=uuid-macbook
  POST: http://server:7860/cluster/message?machineId=uuid-macbook
  → Server 内部转发到 MacBook 的 bridge
```

transport.ts 自动处理: 先尝试直连 → 失败 → 切换到 server 代理。

**seq 处理规则:**
- 直连和代理使用同一套 seq（代理透传原始 seq，不重新编号）
- 切换时不重置 lastSeq，代理从 Last-Event-ID 继续
- 代理模式下 POST /cluster/message 转发到目标 client 的 POST /messages
- 代理 SSE 转发时保持原始 id/event/data 格式不变

---

## 目标 2: 接近原生 CC 体验

### CC 源码分析发现的差距

Claude Code 有 38 种消息类型。remote-cc 只正确处理了约 10 种。关键缺失:

| 缺失 | 影响 | 优先级 |
|------|------|--------|
| 工具调用渲染 | 看不到 CC 在干什么 | P0 |
| 工具结果 (bash输出/diff/文件) | 看不到执行结果 | P0 |
| 执行进度 | 以为卡死了 | P0 |
| Token/Cost | 不知道花了多少钱 | P1 |
| Slash commands | /model /compact 不能用 | P1 |
| AskUserQuestion 交互 | 选项能看不能选 | P1 |
| 代码语法高亮 | 代码块太丑 | P2 |
| Markdown 表格 | 表格不渲染 | P2 |

### 2.1 工具调用卡片 (ToolUseCard)

```
执行中:
┌─ 🔧 Bash ────────────────── ⏳ 3s ─┐
│  npm test                            │
└──────────────────────────────────────┘

完成:
┌─ ✅ Bash ────────────────── 2.1s ──┐
│  npm test                            │
├──────────────────────────────────────┤
│  stdout:                             │
│  Test Files  12 passed (12)          │
│  Tests  187 passed (187)             │
│                                      │
│  [▼ 展开完整输出]                     │
└──────────────────────────────────────┘

失败:
┌─ ❌ Bash ────────────────── 0.5s ──┐
│  npm build                           │
├──────────────────────────────────────┤
│  stderr:                             │
│  Error: Cannot find module 'xxx'     │
└──────────────────────────────────────┘
```

处理 tool_use 和 tool_result 消息，按工具类型分渲染:
- Bash: 显示命令 + stdout/stderr 分离
- Read: 显示文件路径 + 内容预览
- Write: 显示文件路径 + "文件已创建"
- Edit: 显示文件路径 + diff 视图
- Glob/Grep: 显示搜索结果列表

### 2.2 Diff 视图 (DiffView)

```
┌─ ✅ Edit ─ bridge/src/index.ts ─────┐
│                                      │
│  @@ -165,3 +165,3 @@                │
│  - const ws = createWsServer(...)    │
│  + const sse = createSseWriter(...)  │
│                                      │
│  @@ -209,2 +209,2 @@                │
│  - ws.broadcast(envelope)            │
│  + sse.broadcast(seq, value)         │
│                                      │
└──────────────────────────────────────┘
```

解析 Edit tool 的 old_string / new_string，用 diff 库生成 inline diff。

### 2.3 执行进度

处理 `tool_progress` 消息类型 (目前完全忽略):
```json
{ "type": "tool_progress", "tool_use_id": "xxx", "tool_name": "Bash", "elapsed_time_seconds": 5 }
```

渲染为:
```
⏳ Running Bash... 5s
⏳ Reading bridge/src/index.ts...
⏳ Writing web/src/App.tsx...
```

### 2.4 Token & Cost

处理 `result` 消息的 usage 和 cost 字段:
```json
{ "type": "result", "usage": { "inputTokens": 1234, "outputTokens": 567 }, "total_cost_usd": 0.02, "duration_ms": 2500 }
```

每次回复后显示:
```
↳ 1,801 tokens · $0.02 · 2.5s
```

### 2.5 Slash Commands

拦截输入框里的 / 开头命令，通过 control_request 发送:

| 命令 | 发送方式 |
|------|---------|
| /model | control_request { subtype: "set_model" } |
| /compact | control_request { subtype: "compact" } |
| /cost | 本地计算，从 result 累加 |
| /clear | 清空本地消息列表 |

### 2.6 AskUserQuestion 完整交互

CC 通过 tool_use 发送 AskUserQuestion:
```json
{
  "type": "tool_use",
  "name": "AskUserQuestion",
  "input": {
    "questions": [{ "question": "...", "options": [...] }]
  }
}
```

Web UI 渲染选项按钮 → 用户点击 → 构造 tool_result → POST 回 bridge。

### 2.7 被抑制消息类型的合理展示

目前 App.tsx SKIP_SUBTYPES 抑制了 16 种 system 消息。其中一些应该有用户可见的展示：

| 消息 | 当前 | 应该 |
|------|------|------|
| api_retry | 隐藏 | 显示 "API retrying... (attempt 2)" 小提示 |
| rate_limit_event | 隐藏 | 显示 "Rate limited, waiting 30s" 警告 |
| task_notification | 隐藏 | 显示 "Background task completed" 通知 |
| session_state_changed | 隐藏 | 更新状态指示器 (idle/running) |
| compact_boundary | 隐藏 | 显示 "Context compacted" 小提示 |

其他 (init, hook_*, files_persisted, status) 继续隐藏。

### 2.8 Server 重启恢复

Server 进程重启后，cluster 状态全丢（内存缓存）。恢复策略：
- Server 启动时将 cluster 状态持久化到 `~/.remote-cc/cluster-state.json`
- 每次心跳更新时写盘（debounce 5s）
- 重启后读取，标记所有机器为 "recovering"
- 等待 client 重新心跳（90s 内），恢复正常
- 超过 90s 没心跳的标记 offline

### 2.9 代码语法高亮

集成 highlight.js 或 Shiki:
- 代码块检测语言 (```typescript → typescript)
- 应用语法高亮主题 (匹配深色/浅色模式)

---

## API 总览

### 现有 (每台 bridge，不变)

```
GET  /health
GET  /events/stream              SSE
POST /messages
GET  /sessions/history
POST /sessions/start
POST /sessions/stop
GET  /sessions/status
GET  /machine/info               (Phase 1 新增)
```

### Server 新增 (只有 Server 角色有)

```
POST /cluster/heartbeat          Client 上报心跳
GET  /cluster/status             所有机器状态
GET  /cluster/sessions           所有机器 session 混合列表
POST /cluster/action             转发操作到目标机器
POST /cluster/migrate            Session 迁移
GET  /cluster/stream             SSE 代理 (backup)
POST /cluster/message            消息代理 (backup)
POST /cluster/register           Client 首次注册
```

### Client 新增 (只有 Client 角色有)

```
(内部逻辑) 每 30s POST server/cluster/heartbeat
(启动时)   POST server/cluster/register
```

---

## 新增文件

### Bridge

```
bridge/src/clusterManager.ts      Server: 管理机器注册、心跳、状态缓存
bridge/src/clusterClient.ts       Client: 心跳上报、注册
bridge/src/clusterProxy.ts        Server: 请求代理 + SSE 代理
bridge/src/migrator.ts            Server: session 迁移 (rsync + scp + resume)
```

### Web

```
web/src/MachineDashboard.tsx      多机 Dashboard 页
web/src/MachineConfig.tsx         机器配置 (首次设置 server URL)
web/src/GlobalSessionList.tsx     跨机器 session 列表
web/src/ToolUseCard.tsx           工具调用卡片
web/src/ToolResultCard.tsx        工具结果渲染 (bash/diff/file)
web/src/DiffView.tsx              inline diff
web/src/ProgressIndicator.tsx     执行进度
web/src/CostFooter.tsx            token + cost
web/src/SlashCommandHandler.ts    slash command 拦截
```

### 修改文件

```
bridge/src/index.ts               启动时判断 server/client 角色
bridge/src/httpServer.ts           新增 /cluster/* 路由
web/src/App.tsx                    新增 dashboard 视图 + 新消息类型处理
web/src/MessageRenderer.tsx        集成 ToolUseCard/ToolResultCard/DiffView
web/src/transport.ts               直连 + server 代理 fallback
```

---

## 配置

### 启动参数

```bash
# Server 模式 (Mac Mini A)
remote-cc --role server

# Client 模式 (MacBook, Mac Mini B)
remote-cc --role client --server http://100.96.0.3:7860

# 默认: standalone (现有行为，单机模式)
remote-cc
```

### 环境变量

```
REMOTE_CC_ROLE=server|client|standalone
REMOTE_CC_SERVER=http://100.96.0.3:7860    # client 模式时指向 server
REMOTE_CC_MACHINE_NAME=MacBook              # 显示名
```

---

## Task 列表

### Phase 1: Client-Server 基础 + Dashboard

- [ ] T-01: bridge 启动参数 --role server/client + 环境变量
- [ ] T-02: clusterClient.ts — 心跳上报 + 注册
- [ ] T-03: clusterManager.ts — 接收心跳、缓存状态、超时检测
- [ ] T-04: GET /cluster/status + GET /cluster/sessions API
- [ ] T-05: POST /cluster/action — 请求代理到目标机器
- [ ] T-06: MachineDashboard.tsx — 机器列表 + 状态 + 操作按钮
- [ ] T-07: GlobalSessionList.tsx — 跨机器 session 混合列表
- [ ] T-08: App.tsx 三视图路由 (dashboard → session picker → chat)
- [ ] T-09: clusterProxy.ts — SSE 代理 + POST 代理 (直连 backup)
- [ ] T-10: transport.ts 直连 + server 代理 fallback
- [ ] T-11: GET /machine/info endpoint
- [ ] T-12: E2E 测试 (两台机器)

### Phase 2: 体验升级

- [ ] T-13: ToolUseCard.tsx — 工具调用卡片 (参数+状态+计时)
- [ ] T-14: ToolResultCard.tsx — bash 输出 (stdout/stderr 分离)
- [ ] T-15: DiffView.tsx — Edit 工具 inline diff
- [ ] T-16: ProgressIndicator — tool_progress 消息处理
- [ ] T-17: CostFooter.tsx — result 消息 token/cost 显示
- [ ] T-18: SlashCommandHandler — /model /compact /cost /clear
- [ ] T-19: AskUserQuestion 完整交互 (选项→回传)
- [ ] T-20: 代码语法高亮 (highlight.js)
- [ ] T-21: 被抑制消息类型处理 (api_retry/rate_limit/task_* 合理展示)
- [ ] T-22: MessageRenderer 集成所有新组件
- [ ] T-23: E2E 测试

### Phase 3: 高级功能

- [ ] T-24: Session 迁移 (migrator.ts — rsync + scp + resume，冷迁移)
- [ ] T-25: Codex 引擎支持 (bridge spawn codex)
- [ ] T-26: Quick Task (一键提交 prompt)
- [ ] T-27: Server 重启恢复 (持久化 cluster 状态到磁盘)

---

## 验证标准

### Phase 1
- [ ] Server 启动，Client 注册 + 心跳正常
- [ ] 手机打开 Server → Dashboard 显示所有机器状态
- [ ] 点击 session → 进入对话 (优先直连，回退代理)
- [ ] 从 Dashboard 启动/停止远程机器的 session
- [ ] Client 离线后 Dashboard 显示 offline

### Phase 2
- [ ] Bash 工具: 显示命令 + stdout/stderr 分离 + 执行时间
- [ ] Edit 工具: 显示 inline diff
- [ ] 执行进度: "Running Bash... 5s"
- [ ] 每次回复: 显示 token count + cost
- [ ] /model /compact 命令能用
- [ ] AskUserQuestion 选项能点击回传
- [ ] 代码块有语法高亮

### Phase 3
- [ ] Session 迁移: MacBook → Mini A 完整可用（冷迁移）
- [ ] Codex: bridge 能 spawn codex + 输出走 SSE
- [ ] Server 重启后: client 重新注册，状态恢复正常

---

## 预估工期

| Phase | 内容 | CC 工期 |
|-------|------|---------|
| Phase 1 | Client-Server + Dashboard | 2-3 天 |
| Phase 2 | 体验升级 (10 组件) | 2-3 天 |
| Phase 3 | 迁移 + 代理 + Codex | 1-2 天 |

总计约 1 周 CC 工作时间。
