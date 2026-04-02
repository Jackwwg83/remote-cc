# Tasks — remote-cc V1

## 垂直切片排序

核心旅程：**开发者在手机上远程控制本机 Claude Code**

第一批（端到端旅程）：bridge spawn + WebSocket + 最简 web → 手机发 prompt → 本机 claude 回复 → 手机看到
第二批（体验完善）：流式输出 + 工具调用渲染 + 权限审批 + 文件 viewer
第三批（移动优化）：PWA + Tailscale 检测 + 断线重连 + 响应式

---

## 第一批：端到端打通

### bridge 核心

- [ ] T-01: 项目脚手架（Node.js + TypeScript + Vitest + package.json + tsconfig）
- [ ] T-02: spawner — spawn `claude -p --input-format stream-json --output-format stream-json`，管理 child process 生命周期
- [ ] T-03: buffered line reader — stdin/stdout JSON 帧边界处理（参考 `structuredIO.ts`）
- [ ] T-04: WebSocket server — 本地起 ws server，接收客户端消息，转发到 claude stdin
- [ ] T-05: HTTP server — 提供静态文件（web UI）+ session 管理 API（POST/GET/DELETE /sessions）
- [ ] T-06: auth — token 生成 + 验证（WebSocket upgrade 时校验 Authorization header）
- [ ] T-07: 终端 UI — 启动后打印 QR code + URL + token（参考 `bridgeUI.ts`）

### web 核心

- [ ] T-08: 项目脚手架（React + Vite + Tailwind）
- [ ] T-09: WebSocket 客户端 — 连接 bridge，发送/接收 NDJSON 消息
- [ ] T-10: 对话界面 — 输入框 + 消息列表（user 消息右对齐，assistant 消息左对齐）
- [ ] T-11: 基础消息渲染 — assistant text → Markdown 渲染（marked + highlight.js）

### 端到端验证

- [ ] T-12: E2E 测试 — bridge 启动 → web 连接 → 发 prompt → claude 回复 → web 显示

---

## 第二批：体验完善

### 流式输出

- [ ] T-13: partial message 处理 — SDKPartialAssistantMessage → 逐 token 更新 UI
- [ ] T-14: 渲染节流 — requestAnimationFrame 批量 DOM 更新

### 工具调用

- [ ] T-15: tool_use 渲染 — Bash 命令/文件路径卡片式展示
- [ ] T-16: tool_result 渲染 — 折叠/展开长输出（参考 `CollapsedReadSearchContent.tsx`）
- [ ] T-17: Bash 输出渲染 — stdout/stderr 分离显示（参考 `UserBashOutputMessage.tsx`）

### 权限审批

- [ ] T-18: control_request 渲染 — 全屏审批弹窗（工具名 + 参数 + allow/deny 大按钮）
- [ ] T-19: control_response 发送 — 点 allow/deny → 发 JSON 到 bridge → 转发 claude stdin
- [ ] T-20: 危险命令高亮 — rm/drop/delete/force 等关键词标红

### 文件 viewer

- [ ] T-21: FileRead tool_result 解析 — 提取文件内容 + 行号
- [ ] T-22: 语法高亮渲染 — highlight.js 按文件扩展名选语言
- [ ] T-23: FileEdit diff 渲染 — inline diff 视图（diff2html）

---

## 第三批：移动优化

### PWA

- [ ] T-24: PWA manifest — icon、theme_color、display: standalone
- [ ] T-25: Service Worker — 缓存静态资源（离线加载 UI shell）
- [ ] T-26: 添加到主屏幕提示

### Tailscale 集成

- [ ] T-27: 自动检测 Tailscale — 运行 `tailscale ip` 获取 IP
- [ ] T-28: 未安装/未登录提示 — 退化为 localhost + 提示安装
- [ ] T-29: QR code 生成 — 包含 Tailscale IP + token 的完整 URL

### 断线重连

- [ ] T-30: WebSocket 重连 — 2s backoff × 5 次（参考 `SessionsWebSocket.ts`）
- [ ] T-31: 连接状态 UI — 在线/离线/重连中指示器
- [ ] T-32: claude 进程死亡处理 — 通知 web 端 + 提供 respawn 按钮

### 响应式

- [ ] T-33: 移动端布局 — 代码块横向滚动 + 字体适配
- [ ] T-34: 快捷命令面板 — /clear /compact /cost /model 触摸按钮
- [ ] T-35: thinking 折叠 — details/summary 可展开

---

## 测试

- [ ] T-36: bridge 单元测试 — spawner、buffered reader、auth、WebSocket 路由
- [ ] T-37: web 组件测试 — 消息渲染、权限弹窗、连接状态
- [ ] T-38: 集成测试 — bridge + mock claude + web client 完整链路
