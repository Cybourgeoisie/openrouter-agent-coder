#!/usr/bin/env node
// MCP HTTP fixture for src/mcp/transport-http.test.ts — mounts the SDK's
// `McpServer` behind both transports on a single Node http.createServer:
//   - `POST /mcp`, `GET /mcp`, `DELETE /mcp` → StreamableHTTPServerTransport
//   - `GET /sse` + `POST /messages?sessionId=…` → SSEServerTransport (deprecated)
// The fixture exposes both transports against the same in-process MCP server
// so the test suite can exercise McpHttpClient with either transport against a
// canonical, spec-compliant peer.
//
// Lifecycle:
//   - Binds to 127.0.0.1:0 (random free port), prints `http://127.0.0.1:PORT\n`
//     to stdout, then runs forever.
//   - Parent kills via SIGTERM after the test suite finishes.
//
// Lives outside src/ so it can freely use process.* / top-level await.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

function buildServer() {
  const server = new McpServer({ name: 'echo-http-fixture', version: '0.0.1' });

  server.registerTool(
    'echo',
    {
      description: 'Echo back the input message',
      inputSchema: { message: z.string() },
    },
    async ({ message }) => ({
      content: [{ type: 'text', text: message }],
    }),
  );

  server.registerTool(
    'fail',
    {
      description: 'Always returns isError:true',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: 'intentional failure' }],
      isError: true,
    }),
  );

  server.registerTool(
    'hang',
    {
      description: 'Never resolves — used to test per-call signal cancellation',
      inputSchema: {},
    },
    () => new Promise(() => {}),
  );

  server.registerResource(
    'greeting',
    'memory://greeting.txt',
    { title: 'Greeting', description: 'A static greeting resource', mimeType: 'text/plain' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'hello from fixture' }],
    }),
  );

  server.registerPrompt(
    'wave',
    { description: 'Wave at someone', argsSchema: { name: z.string() } },
    ({ name }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `wave at ${name}` } }],
    }),
  );

  return server;
}

// Streamable HTTP: one McpServer + transport per session. The SDK's
// `StreamableHTTPServerTransport` is stateful — a given transport instance
// owns one session, so each `initialize` request needs a fresh transport.
// Subsequent requests carry `Mcp-Session-Id` and route back to that
// transport.
const streamableSessions = new Map(); // sessionId -> { server, transport }

// SSE: one McpServer + transport per active stream (the deprecated SSE
// transport is session-per-stream by design — `_sessionId` is set in its
// constructor and routed via the `sessionId` query param on POSTs).
const sseSessions = new Map(); // sessionId -> { server, transport }

function isInitializeRequest(body) {
  if (!body) return false;
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => m && m.method === 'initialize');
}

const httpServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // Streamable HTTP — POST messages, GET stream, DELETE terminates session.
    if (url.pathname === '/mcp') {
      let parsedBody;
      if (req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.length > 0) parsedBody = JSON.parse(raw);
      }
      const sessionId = req.headers['mcp-session-id'];
      let entry = typeof sessionId === 'string' ? streamableSessions.get(sessionId) : undefined;
      if (!entry && req.method === 'POST' && isInitializeRequest(parsedBody)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            streamableSessions.set(sid, entry);
          },
        });
        const server = buildServer();
        await server.connect(transport);
        entry = { server, transport };
      }
      if (!entry) {
        res.statusCode = 400;
        res.end('missing or unknown Mcp-Session-Id');
        return;
      }
      if (req.method === 'DELETE') {
        const sid = entry.transport.sessionId;
        if (sid) streamableSessions.delete(sid);
        await entry.transport.handleRequest(req, res, parsedBody);
        entry.server.close().catch(() => {});
        return;
      }
      await entry.transport.handleRequest(req, res, parsedBody);
      return;
    }
    // SSE — initial GET opens the stream + assigns a sessionId.
    if (url.pathname === '/sse' && req.method === 'GET') {
      const transport = new SSEServerTransport('/messages', res);
      const server = buildServer();
      await server.connect(transport);
      sseSessions.set(transport.sessionId, { server, transport });
      res.on('close', () => {
        const entry = sseSessions.get(transport.sessionId);
        if (entry) {
          sseSessions.delete(transport.sessionId);
          entry.transport.close().catch(() => {});
          entry.server.close().catch(() => {});
        }
      });
      return;
    }
    // SSE — POST sends a message routed by sessionId query param.
    if (url.pathname === '/messages' && req.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      const entry = sessionId ? sseSessions.get(sessionId) : undefined;
      if (!entry) {
        res.statusCode = 404;
        res.end('unknown session');
        return;
      }
      await entry.transport.handlePostMessage(req, res);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(String(err && err.message ? err.message : err));
    }
  }
});

httpServer.listen(0, '127.0.0.1', () => {
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  process.stdout.write(`http://127.0.0.1:${port}\n`);
});

// Keep the process alive even if all sockets idle.
const keepalive = setInterval(() => {}, 60_000);

function shutdown() {
  clearInterval(keepalive);
  for (const { server, transport } of streamableSessions.values()) {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  }
  streamableSessions.clear();
  for (const { server, transport } of sseSessions.values()) {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  }
  sseSessions.clear();
  httpServer.close(() => process.exit(0));
  // Hard exit if close() lingers on dangling sockets.
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
