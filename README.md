# remote-cc

Remote control for Claude Code from your phone. Open source, self-hosted, works with any API key.

## Quick Start

```bash
# Install
npm install -g remote-cc

# Start (with Tailscale connected)
remote-cc

# Scan QR code on your phone → done
```

## How It Works

```
Phone (browser) ←WSS→ Your machine (bridge) ←stdin/stdout→ claude -p (stream-json)
                        via Tailscale VPN
```

- Does NOT modify Claude Code — talks to it via stdin/stdout
- Your API key never leaves your machine
- Permission approvals work on your phone
- Streaming output, tool calls, file diffs rendered on mobile

## Requirements

- [Claude Code](https://claude.ai/code) installed (`claude` in PATH)
- [Tailscale](https://tailscale.com/) on both your machine and phone
- Node.js >= 18

## License

MIT
