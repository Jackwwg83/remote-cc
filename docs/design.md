# remote-cc — 设计文档

## 产品定义

**一句话**：开源的 Claude Code Remote Control，用户自部署 relay 到 VPS，手机远程控制本机 Claude Code。

**核心价值**：原版 Claude Code 用 API Key 的用户没有远程控制能力（需要 claude.ai 订阅）。remote-cc 让任何用户都能从手机远程操控，且不改原版 Claude Code 一行代码。

**差异化**：自部署、开源、不依赖 Anthropic 后端、支持所有 API Key 用户。

## 核心假设

Claude Code 官方已经做了 Remote Control（bridge 系统 12000+ 行代码），说明需求真实。但官方方案绑死 claude.ai 订阅 + OAuth + Anthropic 云中转。remote-cc 用自部署 relay 替代 Anthropic 云。

## 架构

### V1 架构（当前开发目标）— Tailscale 直连

V1 只有两个组件，bridge 自己当 server：

| 组件 | 语言 | 部署位置 | 职责 |
|------|------|---------|------|
| **bridge** | Node.js (npm 包) | 用户本机 | spawn claude + HTTP/WebSocket server + 内嵌 Web UI |
| **web** | React (PWA) | 内嵌在 bridge 里 | 手机端对话 UI + 权限审批 |

```
手机浏览器 ←WSS (Tailscale VPN)→ 本机 bridge ←stdin/stdout→ claude --print (stream-json)
```

- bridge 同时是 HTTP server（提供 Web UI）和 WebSocket server（消息路由）
- 手机通过 Tailscale VPN 直连 bridge（`http://100.x.x.x:7860`）
- 不需要 VPS、不需要公网 IP
- API key 永远不离开用户本机
- 权限审批由 Claude Code 内置的 control_request/control_response 协议原生支持

### V2 架构（后续）— 自建 relay

V2 加入 Go relay 云服务，支持公网访问：

| 组件 | 语言 | 部署位置 | 职责 |
|------|------|---------|------|
| **relay** | Go | 用户的 VPS | 消息路由、认证、在线状态、消息缓存、内嵌 Web UI |
| **bridge** | Node.js (npm 包) | 用户本机 | 连 relay + spawn claude 进程 + stdin/stdout 桥接 |
| **web** | React (PWA) | 内嵌在 relay 里 | 手机端对话 UI + 权限审批 |

```
手机浏览器 ←WSS→ VPS relay ←WSS→ 本机 bridge ←stdin/stdout→ claude --print (stream-json)
```

### 用户流程

```bash
# VPS 上（一次性）
docker compose up -d
# relay 启动，自动 TLS，监听 443

# 本机
npm install -g remote-cc
remote-cc --relay wss://my-vps.com
# 终端显示 QR code + 连接 URL + session token

# 手机
扫 QR code → 浏览器打开 PWA → 输入 prompt → 本机 claude 执行 → 结果推回手机
需要权限时 → 手机弹出审批 → 批准/拒绝 → claude 继续/跳过
```

## 技术选型

| 维度 | 选择 | 理由 |
|------|------|------|
| relay 语言 | Go | 单二进制部署、Docker 镜像 ~10MB、goroutine 天然适合大量 WebSocket |
| relay 框架 | 标准库 net/http + gorilla/websocket | 够用，不需要框架 |
| bridge 语言 | Node.js/TypeScript | npm 分发、和 claude 生态一致 |
| web 框架 | React + Vite | PWA 支持好、打包成静态文件内嵌到 relay |
| 消息协议 | Claude Code stream-json（原版协议） | 100% 兼容，不发明新协议 |
| 认证 | 分层 token（见安全设计） | 自签发，无第三方依赖 |
| 部署 | Docker Compose + 自动 TLS | 一行启动 |

## 项目分类

- 类型：I（工具开发）+ C（Full-Stack）混合
- Workflow：solo-medium + 产品模式叠加
- 测试栈：Go → `go test`，Node → Vitest，React → Vitest + RTL

## 完整功能范围

### relay

- Session CRUD（创建、列出、查看、终止）
- WebSocket 消息路由（CLI ↔ 手机配对转发）
- 最小信封解析（auth、control type routing、session lifecycle signals）
- 分层认证（admin token + session-scoped client token）
- 在线状态 + 心跳检测
- 消息缓存（time/byte-bounded ring buffer + reconnect cursor）
- session 生命周期管理（creating → running → detached → stopped）
- idle timeout + session TTL
- 内嵌 Web UI 静态文件
- 自动 TLS（Let's Encrypt / 手动证书）
- Docker 部署 + healthcheck + restart policy
- 持久化 session index（relay 重启不丢活跃 session）

### bridge

- 连接 relay WebSocket + auth 握手
- spawn claude 进程（stream-json 模式 + 完整 flag 集）
- buffered line reader/writer（处理 stdin/stdout JSON 帧边界）
- WebSocket ↔ stdin/stdout 双向桥接
- child process 生命周期管理（启动失败、非零退出、畸形 JSON、进程死亡）
- cwd 白名单/策略检查（防止远程指定任意目录）
- 终端 UI（QR code、连接状态、session info）
- 断线自动重连（2s backoff，最多 5 次）
- 多 session 支持

### web (PWA)

- 对话界面（输入框 + 消息流）
- Markdown + 代码块渲染（syntax highlight）
- 工具调用展示（折叠/展开，参数 + 结果）
- 权限审批弹窗（Bash 命令预览 + allow/deny）
- 思考过程展示（thinking 折叠）
- 流式输出（逐 token 更新）
- 连接状态指示（在线/离线/重连中）
- 会话列表（多 session 切换）
- 响应式布局（手机/平板/桌面）
- PWA manifest（添加到主屏幕、全屏运行）
- 断线自动重连 + 消息重放

## 安全设计

### 分层认证

| 层级 | token 类型 | 作用域 | 生命周期 |
|------|-----------|--------|---------|
| **admin** | bridge secret | 整个 relay 实例 | 长期，配置文件指定或启动时生成 |
| **session** | session token | 绑定 session_id + 角色 | 短期，session 创建时签发，session 结束时失效 |
| **client** | QR code 里的一次性 token | 绑定 session + 首次连接 IP | 一次性，连接后作废 |

### 传输安全

- 必须 TLS（WSS），HTTP 模式仅限 localhost 调试
- relay 自动 Let's Encrypt（需要域名）或手动证书

### 访问控制

- cwd 白名单：bridge 侧配置允许远程访问的目录列表，session 创建时的 cwd 必须在白名单内
- Origin/Host 校验：Web UI 的 WebSocket 连接校验 Origin header
- 连接数限制：单 session 最多 1 个 client 连接
- rate limit：session 创建 + 消息发送频率限制

### 安全边界

```
relay 能看到的：消息信封（type/subtype/session_id），用于路由
relay 看不到的：API key（在本机环境变量），对话语义内容不存储不索引
bridge 保证的：只 spawn claude 进程，不执行任意命令
```

## relay 部署方案

### docker-compose.yml

```yaml
version: '3.8'
services:
  relay:
    image: ghcr.io/xxx/remote-cc-relay:latest
    ports:
      - "443:443"
      - "80:80"      # Let's Encrypt HTTP-01 challenge
    volumes:
      - ./config.yaml:/etc/remote-cc/config.yaml
      - relay-data:/var/lib/remote-cc    # session 持久化
      - certs:/etc/remote-cc/certs       # TLS 证书缓存
    environment:
      - REMOTE_CC_DOMAIN=remote.example.com
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8080/health"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  relay-data:
  certs:
```

### config.yaml

```yaml
server:
  domain: remote.example.com
  port: 443

tls:
  auto: true                    # Let's Encrypt
  # cert: /path/to/cert.pem    # 或手动证书
  # key: /path/to/key.pem

auth:
  admin_token: ""               # 空 = 启动时自动生成
  
session:
  max_concurrent: 10
  idle_timeout: 30m
  max_ttl: 24h
  message_buffer_bytes: 10485760   # 10MB ring buffer
  message_buffer_ttl: 1h

security:
  allowed_origins: ["*"]        # 生产环境限制为你的域名
  rate_limit:
    sessions_per_minute: 5
    messages_per_second: 10
```

### relay 重启行为

- session index 持久化到 `/var/lib/remote-cc/sessions.json`
- relay 重启后读取 index，标记所有 session 为 `detached`
- bridge 重连时 reattach 到已有 session
- 超过 idle_timeout 未 reattach 的 session 清理
