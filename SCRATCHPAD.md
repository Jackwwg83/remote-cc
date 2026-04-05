# remote-cc SCRATCHPAD — Resume Point

## Current State (v0.2.0, 2026-04-05)

Released v0.2.0 with two major features:
1. **Session Management** — SessionPicker UI, sessionScanner, processManager, --continue/--resume CLI
2. **SSE Transport** — replaced WebSocket with SSE (down) + POST (up), matching Claude Code v2 architecture

187 bridge tests passing. 8/8 E2E browser tests. Phase 7 quality gate complete (20 issues found and fixed).

## Architecture

```
Web UI (React) ← SSE GET /events/stream ← Bridge (Node.js) ← Claude stdout
Web UI (React) → POST /messages → Bridge (Node.js) → Claude stdin
```

Key modules: sseWriter.ts, transport.ts, processManager.ts, sessionScanner.ts, httpServer.ts

## What's Next

### Must Do
- F-02: Slash commands (/model /compact /clear) via control_request protocol
- F-04: Model switcher UI

### Should Do
- B-04: AskUserQuestion interactive UI (renders options but doesn't send responses)
- B-05: EnterPlanMode display
- sseWriter unit tests (T-S06, deferred)

### Known Issues (deferred from Phase 7)
- processManager SIGKILL: works but ClaudeProcess.forceKill added
- Session boundary replay edge case on reconnect between sessions
- Scanner unbounded parallel I/O (no concurrency limit)
- PWA Service Worker caches stale JS after rebuild

## Git
- Branch: main
- Latest: v0.2.0 tag at 4862c06
- Remote: https://github.com/Jackwwg83/remote-cc
