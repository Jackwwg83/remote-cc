# Tasks — remote-cc V1

## 垂直切片排序

核心旅程：**开发者在手机上远程控制本机 Claude Code**

第一批（端到端）：bridge spawn + initialize 握手 + WebSocket + 最简 web → 手机发 prompt → claude 回复
第二批（体验）：流式输出 + 工具渲染 + 权限审批 + 文件 viewer + auth + 消息缓存
第三批（移动优化）：PWA + Tailscale 检测 + 断线重连 + 响应式

---

## 第一批：端到端打通

### bridge 核心

- [ ] T-01: 项目脚手架（Node.js + TypeScript + Vitest + package.json + tsconfig）
- [ ] T-02: spawner — spawn `claude --print --input-format stream-json --output-format stream-json --verbose --include-partial-messages --include-hook-events --replay-user-messages`，管理 child process 生命周期（含测试）
- [ ] T-03: buffered line reader/writer — stdin/stdout JSON 帧边界处理（参考 structuredIO.ts）（含测试）
- [ ] T-04: **initialize 握手** — 收到 claude 的 control_request (subtype: initialize) 后回复 control_response（commands: [], output_style: 'normal', models: [], account: {}, pid）。不处理这个 claude 不会开始工作（含测试）
- [ ] T-05: WebSocket server — 本地起 ws server，接收客户端消息，转发到 claude stdin（含测试）
- [ ] T-06: HTTP server — 提供静态文件（web UI）+ session 管理 API（POST/GET/DELETE /sessions）
- [ ] T-07: 终端 UI — 启动后打印连接 URL（QR code 放第三批）

### web 核心

- [ ] T-08: 项目脚手架（React + Vite + Tailwind）
- [ ] T-09: WebSocket 客户端 — 连接 bridge，发送/接收 NDJSON 消息（含测试）
- [ ] T-10: 对话界面 — 输入框 + 消息列表（user 右对齐，assistant 左对齐）
- [ ] T-11: 基础消息渲染 — assistant text → Markdown 渲染（marked + highlight.js），注意 content 是数组（text + thinking + tool_use 混合）

### 端到端验证

- [ ] T-12: E2E 测试 — bridge 启动 → web 连接 → 发 prompt → initialize 握手 → claude 回复 → web 显示

---

## 第二批：体验完善

### 流式输出

- [ ] T-13: partial message 状态机 — content_block_start/delta/stop 管理 + 和完整 assistant message 的切换（含测试）
- [ ] T-14: 渲染节流 — requestAnimationFrame 批量 DOM 更新

### 工具调用

- [ ] T-15: tool_use 渲染 — Bash 命令/文件路径卡片式展示
- [ ] T-16: tool_result 渲染 — 折叠/展开长输出
- [ ] T-17: Bash 输出渲染 — stdout/stderr 分离显示
- [ ] T-18: 状态消息渲染 — SDKStatusMessage、SDKAPIRetryMessage、SDKRateLimitEvent

### 权限审批

- [ ] T-19: control_request (can_use_tool) 渲染 — 全屏审批弹窗 + allow/deny 大按钮
- [ ] T-20: control_response 发送 — 点 allow/deny → JSON 回 bridge → 转发 claude stdin（含 request_id 配对）
- [ ] T-21: 危险命令高亮 — rm/drop/delete/force 标红

### 文件 viewer

- [ ] T-22: FileRead tool_result 解析 + 语法高亮渲染（highlight.js）
- [ ] T-23: FileEdit diff 渲染 — inline diff（diff2html）

### 认证 + 消息缓存

- [ ] T-24: token 认证 — 生成 + 验证（WebSocket upgrade 时校验 Authorization header）
- [ ] T-25: bridge 侧消息缓存 — 保留最近 200 条 StdoutMessage，客户端重连后重放

---

## 第三批：移动优化

### PWA

- [ ] T-26: PWA manifest — icon、theme_color、display: standalone
- [ ] T-27: Service Worker — 缓存静态资源
- [ ] T-28: 添加到主屏幕提示

### Tailscale 集成

- [ ] T-29: 自动检测 Tailscale — 运行 `tailscale ip` 获取 IP + 状态
- [ ] T-30: 未安装/未登录退化 — localhost 模式 + 提示
- [ ] T-31: QR code 生成 — Tailscale IP + token 的完整 URL

### 断线重连

- [ ] T-32: WebSocket 重连 — 2s backoff × 5 次 + navigator.onLine 监听
- [ ] T-33: 重连消息重放 — 连接时带 last_seq → bridge 重放缓存
- [ ] T-34: 连接状态 UI — 在线/离线/重连中指示器

### 响应式 + 完善

- [ ] T-35: 移动端布局 — 代码块横向滚动 + 字体适配
- [ ] T-36: 快捷命令面板 — /clear /compact /cost /model
- [ ] T-37: thinking 折叠 — details/summary
- [ ] T-38: claude 版本兼容检测 — bridge 启动时 `claude --version` 对比已知兼容版本

---

## Bug fixes（真实浏览器测试发现）

- [ ] B-01: 用户消息重复 — 本地 echo + --replay-user-messages 回传导致显示两遍。需要去重：要么去掉本地 echo 只用 replay，要么过滤 replay
- [ ] B-02: Claude 回复重复 — streaming partial 累积的完整消息 + 最终 assistant 消息都加进了列表。需要在收到完整 assistant 时替换（不是追加）streaming 的那条
- [ ] B-03: 多种 system subtype 暴露 — status, task_started, task_progress, task_notification, session_state_changed, files_persisted, api_retry, rate_limit 都没过滤，显示了 raw JSON。需要加到 skipSubtypes 或者格式化显示
- [ ] B-04: AskUserQuestion 工具调用显示 raw JSON — 应该渲染成交互式选择 UI（选项按钮），用户点选后发回 tool_result
- [ ] B-05: EnterPlanMode 工具调用显示 {} — 应该渲染成"进入计划模式"的状态提示，不是空 JSON
- [ ] B-06: 主题切换 — Web UI 加深色/浅色模式切换按钮，默认跟随系统 prefers-color-scheme，可手动切换并 localStorage 持久化
- [ ] B-07: 权限弹窗缺 "Always Allow" — 原版有三个选项：Allow / Always Allow / Deny。Always Allow 通过 control_response 的 updatedPermissions 字段传递权限规则，Claude 会持久化。参考 rdcc PermissionPromptToolResultSchema.ts 的 updatedPermissions 字段
- [ ] B-08: tool_result 在 user replay 消息里显示为蓝色气泡 — user replay 消息的 content 如果是 tool_result 数组，不应该显示为普通文字气泡，应该跳过或格式化显示

---

## 功能缺口（手机联合测试发现，走新增功能流程）

### 必做（不做基本不可用）
- [ ] F-01: Session 管理 — 支持 --continue（恢复最近会话）和 --resume <session_id>（指定会话），通过 bridge CLI 参数或 web UI 选择
- [ ] F-02: Slash commands — /model /compact /clear /cost 等需要通过 control_request 协议发送，不是 user message。Quick Commands 面板需要重做

### 应做（提升体验）
- [ ] F-03: 会话列表 — web UI 显示可用 sessions，点击切换
- [ ] F-04: 模型切换 — web UI 的模型选择器，通过 set_model control_request 切换
