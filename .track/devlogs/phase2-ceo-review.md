# Phase 2 CEO Review — 2026-04-02

## 审视模式：SELECTIVE EXPANSION

## 关键决策

### 架构：V1 Tailscale 直连，V2 加 relay
- V1 只做 bridge + web，用 Tailscale VPN 穿透
- 不需要 VPS、不需要自建 relay
- 工作量从 5-6 周压缩到 2-3 周
- V2 再加 Go relay 支持公网访问

### Cherry-picks 决策
| # | 提案 | 决策 | 理由 |
|---|------|------|------|
| 1 | 多 CLI 支持 | DEFER | 先支持 claude code，后续考虑 codex |
| 2 | 文件 viewer（语法高亮） | ACCEPTED | 提升工具调用的可读性 |
| 3 | Cloudflare Tunnel 备选 | DEFER | V1 用 Tailscale 够了，V2 再加 |
| 4 | 自动检测 Tailscale IP | ACCEPTED | 用户体验提升，工作量 S |

### 安全决策
- V1 Tailscale 方案安全性高（WireGuard 加密 + 设备认证）
- Cloudflare Tunnel 有 URL 泄露风险，需要 token 双重保护，放 V2
- 权限审批由 Claude Code 原生 control_request/response 支持

## 新增文档
- `docs/web-ui-rendering.md` — 手机端渲染设计，对标原版 CLI 组件

## 下一步
- Phase 3：架构设计 + 实施计划
