# remote-cc

Remote control for Claude Code from your phone. Open source, self-hosted, works with any API key.

No cloud relay needed. Your machine runs the bridge, your phone connects directly.

## Quick Start

```bash
# Clone and build
git clone https://github.com/Jackwwg83/remote-cc.git
cd remote-cc
cd web && npm install && npm run build && cd ..
cd bridge && npm install

# Start the bridge
npx tsx src/index.ts

# Scan the QR code on your phone
```

The bridge prints a URL with an auth token. Scan the QR code or open the URL on your phone.

## How It Works

```
Phone (browser)                     Your machine
    |                                    |
    |  GET /events/stream (SSE)   <---   |  <-- claude stdout
    |  POST /messages             --->   |  --> claude stdin
    |                                    |
    |  GET /sessions/history      <---   |  scans ~/.claude/projects/
    |  POST /sessions/start       --->   |  spawns claude --print --resume <id>
```

- **SSE** (Server-Sent Events) for server-to-client streaming, auto-reconnects on mobile
- **HTTP POST** for client-to-server messages
- Does NOT modify Claude Code ... talks to it via `--print --stream-json` stdin/stdout
- Your API key never leaves your machine
- Permission approvals work on your phone (Allow / Always Allow / Deny)

## Features

### Session Management
Browse all your Claude Code sessions, resume any one, or start fresh.

```bash
# Start bridge, pick session from web UI
npx tsx src/index.ts

# Auto-resume the most recent session
npx tsx src/index.ts --continue

# Resume a specific session by ID
npx tsx src/index.ts --resume abc123
```

The session picker shows all sessions from `~/.claude/projects/` with project name, time, and first message summary.

### Mobile-Optimized Web UI
- Dark/light mode with system preference detection
- Touch-friendly (44px+ tap targets)
- PWA installable (Add to Home Screen)
- IME composition support for Chinese/Japanese/Korean input
- Streaming output with rAF throttling

### Connection Stability
Built on SSE (same transport as Claude Code's official remote control):
- EventSource native auto-reconnect
- `Last-Event-ID` for seamless message replay
- 45-second liveness timeout detects half-open connections
- 15-second keepalive prevents proxy timeouts
- Manual reconnect with exponential backoff (1s to 30s, 10-minute budget)
- `navigator.onLine` listener for instant reconnect on network recovery

### Permission Approval
When Claude needs to run a tool (read file, write file, run command), a permission dialog appears on your phone:
- **Allow** ... one-time approval
- **Always Allow** ... permanent rule for this tool
- **Deny** ... reject the operation

### Security
- Random auth token generated on each bridge start (`rcc_` + 32 bytes)
- Token required on all API endpoints (Bearer header or ?token= query param)
- Path traversal protection on static file serving
- POST message idempotency with `_messageId` dedup
- No data leaves your machine ... direct connection via LAN or Tailscale

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed (`claude` in PATH)
- Node.js >= 18
- A way to connect your phone to your machine:
  - **Same WiFi** ... use the LAN IP shown in the terminal
  - **[Tailscale](https://tailscale.com/)** ... install on both devices for secure access from anywhere

## CLI Options

```
remote-cc [options]

Options:
  --port, -p <port>       Server port (default: 7860)
  --continue, -c          Resume the most recent session
  --resume <session-id>   Resume a specific session by ID
  --help, -h              Show help
  --version, -v           Show version
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/events/stream` | ?token= | SSE stream (claude output + session status + keepalive) |
| POST | `/messages` | Bearer | Send user messages to claude |
| GET | `/sessions/history` | Bearer | List all scannable sessions |
| POST | `/sessions/start` | Bearer | Start new or resume existing session |
| POST | `/sessions/stop` | Bearer | Stop current claude process |
| GET | `/sessions/status` | Bearer | Current process state (idle/running) |
| GET | `/health` | None | Health check |

## Architecture

```
bridge/src/
  index.ts            Main wiring (HTTP + SSE + session lifecycle)
  httpServer.ts       HTTP routes + static file serving
  sseWriter.ts        SSE connection manager + keepalive
  processManager.ts   Process state machine (idle/spawning/running/stopping)
  sessionScanner.ts   Scans ~/.claude/projects/ for session metadata
  spawner.ts          Spawns claude --print --stream-json
  lineReader.ts       Buffered NDJSON reader for claude stdout
  initializer.ts      Claude initialization handshake
  messageCache.ts     Ring buffer (200 msgs) for reconnect replay
  auth.ts             Token generation + verification

web/src/
  App.tsx             Main React component (session picker + chat)
  transport.ts        SSE + POST client (replaces WebSocket)
  SessionPicker.tsx   Session selection UI
  MessageRenderer.tsx Message rendering (text, tool_use, thinking)
  PermissionDialog.tsx Permission approval (Allow/Always Allow/Deny)
  streamingState.ts   Streaming state machine for partial messages
```

## Development

```bash
# Bridge (with auto-reload)
cd bridge && npx tsx --watch src/index.ts

# Web UI (Vite dev server with HMR)
cd web && npm run dev

# Run tests
cd bridge && npm test

# Build web for production
cd web && npm run build
```

187 bridge tests covering spawner, line reader, initializer, auth, HTTP routes, session scanner, process manager, and message cache.

## FAQ

**Q: Does this work without a Tailscale/Claude subscription?**
A: Yes. You just need `claude` CLI installed with a valid API key. No paid subscription required. Connect via your local WiFi network.

**Q: Is my data sent to any server?**
A: No. Everything stays on your machine. The bridge runs locally and your phone connects directly to it.

**Q: What happens when my phone locks/sleeps?**
A: The SSE connection may drop, but EventSource auto-reconnects with `Last-Event-ID` replay. You won't miss any messages.

**Q: Can multiple phones connect at once?**
A: Yes. All connected clients receive the same SSE stream. But only one claude session runs at a time.

## License

MIT
