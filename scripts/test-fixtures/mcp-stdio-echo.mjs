#!/usr/bin/env node
// MCP stdio fixture for src/mcp/transport-stdio.test.ts — tools, a resource,
// and a prompt. Lives outside src/ so it can freely use process.* / top-level await.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-fixture', version: '0.0.1' });

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

await server.connect(new StdioServerTransport());
