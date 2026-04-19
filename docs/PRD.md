# PRD: remote-cc

## 一、问题定义

Claude Code 的 Remote Control 功能（从手机远程操控本机 CLI）只对 claude.ai 订阅用户开放。使用 API Key 的用户（大多数开发者）无法使用。remote-cc 为所有 Claude Code 用户提供开源、自部署的远程控制方案。

## 二、用户场景

### 场景 1：外出时监控长任务
触发：开发者启动了一个大型重构任务，需要离开电脑
操作：手机打开 remote-cc PWA → 看到 claude 正在执行 → 收到权限审批请求 → 手机上批准
结果：任务不中断，开发者在外面也能跟进进度和审批

### 场景 2：沙发/床上写代码
触发：不想坐到电脑前，但想让 claude 做点事
操作：手机打开 PWA → 输入 prompt → 看到 claude 在本机执行 → 查看结果
结果：躺着就把代码写了

### 场景 3：在另一台电脑上远程操控
触发：在公司的电脑上想操控家里电脑的 claude
操作：浏览器打开 remote-cc URL → 输入 prompt → 家里的 claude 执行
结果：跨设备远程开发

## 三、功能边界

### V1 做什么（Must Have）
- bridge 本地进程：spawn claude + WebSocket server + QR code
- Web PWA：对话 UI + 流式输出 + 权限审批 + 工具调用渲染
- 文件 viewer（syntax highlight）
- Mesh overlay 自动检测 + IP 输出（Cloudflare WARP 默认 / Tailscale 兼容）
- token 认证
- 断线重连

### V2 做什么（Future）
- Go relay 云服务（自部署 VPS）
- 消息缓存 + 断线重放
- session detach/reattach
- Cloudflare Tunnel 备选穿透
- 多 CLI 支持（codex 等）
- 多用户/多 session

### 不做什么（Out of Scope）
- 修改原版 Claude Code
- 自建 AI 模型调用
- 替代 SSH/终端
- E2E 加密（V1）
- 原生 App（用 PWA 替代）

## 四、技术方案约束

- 不改原版 Claude Code，通过 `claude -p --input-format stream-json --output-format stream-json` 桥接
- 消息协议 100% 对齐 Claude Code SDK stream-json 格式
- V1 穿透依赖 mesh overlay（Cloudflare WARP 默认，Tailscale 兼容，用户自装）
- bridge 用 Node.js/TypeScript（npm 分发）
- web 用 React + Vite（PWA，内嵌在 bridge 进程里）
- V2 relay 用 Go

## 五、验收标准

| 功能 | 验收标准 |
|------|---------|
| bridge 启动 | `remote-cc` → 终端显示 QR code + mesh IP + URL，3 秒内就绪 |
| 手机连接 | 扫 QR code → PWA 打开 → 显示 "Connected"，5 秒内 |
| 发送 prompt | 手机输入 "hi" → 本机 claude 执行 → 手机看到回复，延迟 < 1 秒（不算 AI 生成时间）|
| 流式输出 | AI 回复逐 token 出现在手机上，和本地 CLI 同步 |
| 权限审批 | claude 要执行 Bash → 手机弹出审批 → 点 Allow → claude 继续 |
| 文件 viewer | claude 读取文件 → 手机显示文件内容 + 语法高亮 |
| Markdown | AI 回复包含代码块 → 手机正确渲染 + syntax highlight |
| 断线重连 | 手机 WiFi 断一下 → 自动重连 → 不丢当前消息 |
| Mesh 检测 | mesh client 已连接 → 显示 `http://100.x.x.x:7860`；未连接 → 提示 `warp-cli connect` 或 `tailscale up` |
| 安全 | 无 token 的 WebSocket 连接被拒绝（4003 close） |

## 六、风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Claude Code stream-json 格式变更 | Low | High | 容错设计：不识别的 type 透传不拦截 |
| Mesh overlay 不支持某些网络环境 | Med | Med | V2 加 relay 备选；手机已内置 Cloudflare WARP 的场景下直连更稳 |
| 手机浏览器 WebSocket 限制（iOS Safari 后台断连）| Med | Med | 自动重连 + PWA 保活 |
| stream-json 大量 partial messages 导致手机卡顿 | Low | Med | requestAnimationFrame 节流 + 虚拟滚动 |
