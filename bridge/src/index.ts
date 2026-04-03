#!/usr/bin/env node
/**
 * remote-cc bridge — spawn claude + WebSocket server + terminal UI
 */

import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    relay: { type: 'string', short: 'r' },
    port: { type: 'string', short: 'p', default: '7860' },
    local: { type: 'boolean', default: true },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
})

if (args.version) {
  console.log('remote-cc v0.1.0')
  process.exit(0)
}

if (args.help) {
  console.log(`
remote-cc — Remote control for Claude Code

Usage:
  remote-cc [options]

Options:
  --port, -p <port>    WebSocket server port (default: 7860)
  --relay, -r <url>    Connect to a relay server (V2, not yet implemented)
  --local              Direct connect mode via Tailscale (default)
  --help, -h           Show this help
  --version, -v        Show version
  `)
  process.exit(0)
}

async function main() {
  const port = parseInt(args.port ?? '7860', 10)
  
  console.log('🚀 remote-cc starting...')
  console.log(`   Mode: ${args.relay ? 'relay' : 'local (Tailscale)'}`)
  console.log(`   Port: ${port}`)
  console.log()
  
  // T-02: spawner
  // T-03: buffered line reader
  // T-04: initialize handshake
  // T-05: WebSocket server
  // T-06: HTTP server
  // T-07: terminal UI
  
  // TODO: implement — this is the scaffolding
  console.log('⚠️  Not yet implemented. See .track/TASKS.md for task breakdown.')
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
