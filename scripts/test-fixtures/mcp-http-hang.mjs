#!/usr/bin/env node
// Hung MCP HTTP fixture: accepts incoming HTTP connections but never replies,
// so the SDK's `initialize` POST (or SSE GET stream) hangs indefinitely. Used
// by the abort-mid-handshake test in src/mcp/transport-http.test.ts.
//
// Mounts the same routing paths as the echo fixture (`/mcp`, `/sse`,
// `/messages`) but every handler just buffers the request and never
// terminates the response.
import http from 'node:http';

const server = http.createServer((req, res) => {
  // Drain the body so the client's write doesn't backpressure.
  req.resume();
  // For the SSE GET path we need to send the `200 OK` + `text/event-stream`
  // headers so the EventSource opens — otherwise it errors immediately on
  // missing content-type and the SDK retries instead of waiting. Once open,
  // we never emit any events (in particular no `endpoint` event), so the
  // SDK's `_startOrAuth` Promise hangs and is rejected by our
  // race-vs-abort path in McpHttpClient.connect().
  if (req.method === 'GET' && (req.url ?? '').startsWith('/sse')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Send an initial keepalive comment so EventSource fires `onopen`.
    res.write(':\n\n');
    return;
  }
  // For all other paths (incl. `/mcp` Streamable HTTP POST), never reply.
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  process.stdout.write(`http://127.0.0.1:${port}\n`);
});

// Keep the event loop alive until SIGTERM.
const keepalive = setInterval(() => {}, 60_000);

function shutdown() {
  clearInterval(keepalive);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
