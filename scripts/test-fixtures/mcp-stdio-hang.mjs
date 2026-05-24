#!/usr/bin/env node
// Hung MCP stdio fixture: drains stdin but NEVER replies on stdout, so the
// `initialize` handshake hangs indefinitely. Used by the abort-mid-handshake
// test in src/mcp/transport-stdio.test.ts.
process.stdin.resume();
process.stdin.on('data', () => {});
// Keep the event loop alive until the parent SIGTERMs us.
setInterval(() => {}, 60_000);
