# Web UI 渲染设计

> 目标：手机端体验尽可能接近本地 CLI，同时适配移动端交互
> 参考：rdcc `src/components/Message.tsx`、`Messages.tsx`、`MessageRow.tsx` 的渲染逻辑

## 消息类型 → 渲染映射

原版 CLI（Ink React）的每种消息类型在 Web PWA 里的对应渲染方案：

| 原版 Message.tsx case | CLI 渲染 | Web PWA 渲染 |
|----------------------|---------|-------------|
| `assistant` (text) | Ink `<Markdown>` | `marked` + `highlight.js` |
| `assistant` (thinking) | 折叠的灰色文本 | `<details>` 折叠，灰色背景 |
| `assistant` (tool_use) | 工具名 + spinner | 卡片式展示：工具图标 + 参数 + 状态 |
| `tool_result` (success) | 折叠的输出文本 | 卡片式展示：可展开的代码块 |
| `tool_result` (error) | 红色错误文本 | 红色边框卡片 |
| `user` | 右对齐蓝色气泡 | 右对齐蓝色气泡（聊天风格） |
| `system` | 灰色居中文本 | 灰色分隔条 |
| `collapsed_read_search` | 折叠的文件列表 + spinner | 文件列表卡片 + 状态指示 |
| `grouped_tool_use` | 批量工具调用折叠 | 可展开的工具调用组 |
| `control_request` (can_use_tool) | 权限弹窗 | 全屏审批弹窗（大触摸按钮） |
| `stream_event` (partial) | 逐 token 追加 | 逐 token 追加（requestAnimationFrame 节流） |

## 流式输出渲染

原版 CLI 通过 Ink 的 React reconciler 直接更新终端。Web 端需要模拟同样的"逐 token 出现"效果。

### 参考：原版的 `SDKPartialAssistantMessage`

```json
{
  "type": "assistant",
  "subtype": "partial",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": { "type": "text_delta", "text": "我看了" }
  }
}
```

### Web 端实现

```typescript
// 流式消息状态
interface StreamingState {
  messageId: string
  contentBlocks: ContentBlock[]  // 随 delta 累积
  isStreaming: boolean
}

// 收到 partial message 时
function handlePartialMessage(event: SDKPartialAssistantMessage) {
  if (event.event.type === 'content_block_start') {
    // 新建 content block
    addContentBlock(event.event.content_block)
  } else if (event.event.type === 'content_block_delta') {
    // 追加到现有 block
    appendToBlock(event.event.index, event.event.delta)
  } else if (event.event.type === 'message_stop') {
    // 流结束，切换到完整消息
    finalizeMessage()
  }
}

// 渲染节流：不要每个 token 都触发 DOM 更新
// 用 requestAnimationFrame 批量更新（~16ms 一帧）
let pendingUpdate = false
function scheduleRender() {
  if (!pendingUpdate) {
    pendingUpdate = true
    requestAnimationFrame(() => {
      renderMessages()
      pendingUpdate = false
    })
  }
}
```

## 工具调用渲染

原版 CLI 的工具调用渲染在 `Message.tsx:484`（tool_use case）和 `GroupedToolUseContent.tsx`。

### Bash 命令

```
原版 CLI:
⏵ Bash(git diff)
  └─ [stdout output, collapsed if >5 lines]

Web PWA:
┌─────────────────────────────────┐
│ 🔧 Bash                         │
│ $ git diff                       │
│ ┌─ Output ──────────── ▼ ──────┐│
│ │ diff --git a/foo.ts b/foo.ts ││
│ │ - old line                    ││
│ │ + new line                    ││
│ └───────────────────────────────┘│
└─────────────────────────────────┘
```

### 文件读取

```
原版 CLI:
⤿ Read(src/main.tsx) [4683 lines]

Web PWA (Cherry-pick #2: file viewer):
┌─────────────────────────────────┐
│ 📄 Read: src/main.tsx            │
│ ┌─ Preview ─────────── ▼ ──────┐│
│ │ 1  import { feature } from.. ││
│ │ 2  import chalk from 'chalk' ││
│ │ 3  ...                        ││
│ │    [显示前 20 行 + "展开全部"] ││
│ └───────────────────────────────┘│
└─────────────────────────────────┘
```

### 文件编辑（diff 视图）

```
Web PWA:
┌─────────────────────────────────┐
│ ✏️ Edit: src/utils/auth.ts       │
│ ┌─ Changes ────────── ▼ ──────┐│
│ │ @@ -125,3 +125,3 @@          ││
│ │ - old code                    ││
│ │ + new code                    ││
│ └───────────────────────────────┘│
│ 📊 15 lines changed             │
└─────────────────────────────────┘
```

inline diff（上下对比），不用并排（手机屏幕放不下）。

## 权限审批 UI

原版 CLI 的权限审批在 `PermissionRequest.tsx`（216 行），是终端内的交互弹窗。

### Web 端设计

```
┌─────────────────────────────────┐
│ ⚠️ Permission Required           │
│                                  │
│ Bash wants to execute:           │
│ ┌───────────────────────────────┐│
│ │ rm -rf node_modules           ││
│ │ && npm install                ││
│ └───────────────────────────────┘│
│                                  │
│ Working directory:               │
│ /Users/jack/my-project           │
│                                  │
│ ┌──────────┐  ┌──────────┐      │
│ │  ALLOW   │  │  DENY    │      │
│ │  (大按钮) │  │  (大按钮) │      │
│ └──────────┘  └──────────┘      │
└─────────────────────────────────┘
```

- 按钮至少 48px 高（移动端触摸规范）
- 危险命令（rm、drop、delete 等）ALLOW 按钮标红
- 显示完整命令（不截断）
- 自动滚动到最新权限请求

## 移动端适配

### 代码块

```
问题：代码块在手机上横向溢出
方案：
- 横向可滚动（overflow-x: auto）
- 字体缩小到 12px（默认终端是 14px）
- 长按代码块 → 全屏查看模式（旋转横屏提示）
- 复制按钮（右上角）
```

### 长输出

```
问题：Bash 输出可能几千行
方案（参考原版 CollapsedReadSearchContent.tsx）：
- 默认折叠，只显示最后 5 行 + "展开 (N lines)"
- 展开后虚拟滚动（不一次性渲染全部 DOM）
- 超过 500 行：显示 "Output too long (N lines)" + 下载按钮
```

### 输入体验

```
问题：手机键盘打代码/路径很痛苦
方案：
- 输入框自动聚焦
- 支持多行输入（Shift+Enter 换行，Enter 发送）
- 常用快捷命令面板：
  ┌──────────────────────────┐
  │ /clear  /compact  /cost  │
  │ /model  /help     /exit  │
  └──────────────────────────┘
- 历史命令上翻（↑ 或上滑手势）
```

### Thinking 折叠

```
原版 CLI: 灰色文本 + 折叠
Web PWA:
  ┌ 💭 Thinking... ─────── ▶ ┐    ← 默认折叠
  │ (点击展开)                 │
  └────────────────────────────┘

  展开后：
  ┌ 💭 Thinking ────────── ▼ ┐
  │ Let me analyze this...    │
  │ The issue seems to be...  │
  │ I should check...         │
  └────────────────────────────┘
```

## 连接状态指示

```
在线:    🟢 Connected
重连中:  🟡 Reconnecting... (attempt 2/5)
离线:    🔴 Disconnected — check Tailscale
```

固定在页面顶部或底部状态栏。

## 技术方案

| 组件 | 库 |
|------|-----|
| Markdown 渲染 | `marked` + `DOMPurify`（防 XSS） |
| 代码高亮 | `highlight.js`（和 rdcc 一致） |
| Diff 渲染 | `diff2html`（inline mode） |
| 虚拟滚动 | `@tanstack/react-virtual`（长消息列表） |
| PWA | Vite PWA plugin |
| 响应式 | Tailwind CSS（移动优先） |

## 和原版 CLI 的对应关系

| CLI 组件 (Ink) | Web 组件 (React DOM) | 差异 |
|---------------|---------------------|------|
| `Message.tsx` → switch(type) | `MessageRenderer.tsx` → switch(type) | 相同的分支逻辑，不同的渲染原语 |
| `<Markdown>` (Ink) | `<ReactMarkdown>` + highlight.js | Ink 版解析 ANSI，Web 版解析 HTML |
| `<Box flexDirection>` | `<div className="flex">` | Ink yoga layout → CSS flexbox |
| `<Text color="red">` | `<span className="text-red-500">` | Ink color → Tailwind class |
| `<Spinner>` | CSS animation spinner | |
| `useInput()` (keyboard) | onClick / onTouch | 键盘 → 触摸 |
| `OffscreenFreeze` (性能优化) | React.memo + virtualization | 同等功能 |
