// Comparative-parity emulator entrypoint. Spawns an in-process HTTP server
// bound to an ephemeral port on 127.0.0.1, routes `POST /v1/messages`
// (tolerating `?beta=true` and other query strings) to the Anthropic adapter
// and `POST /v1/chat/completions` to the OpenAI/OR adapter, and exposes
// lifecycle + script-registration helpers for tests.
//
// Hosting pattern locked by spike 6.S1: in-process, ephemeral port, IPv4-only
// bind. The Claude Agent SDK spawns a subprocess per `query()` call and reads
// `ANTHROPIC_BASE_URL` from that subprocess's env, so structural isolation
// drops out of the picture — no parent-process env mutation needed. The
// OpenRouter SDK accepts a `serverURL` option that points its
// `/chat/completions` posts at the emulator's `/v1` prefix.
//
// TODO(6.3): the comparative harness will wrap this entrypoint to spin up
// one emulator per scenario, pre-seed both wires' scripts, and tear it down
// after each scenario completes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';

import { handleAnthropicMessages } from './anthropic.js';
import { handleOpenAIChatCompletions } from './openai.js';
import { ScriptRegistry, type ScriptEntry } from './script-engine.js';

export type EmulatorHandle = {
  readonly url: string;
  readonly port: number;
  readonly registry: ScriptRegistry;
  stop(): Promise<void>;
};

export type CreateEmulatorOptions = {
  host?: string;
};

/**
 * Start the emulator. Resolves once the server is listening with a usable
 * URL. The caller is responsible for invoking `stop()` on teardown — idempotent.
 */
export async function startEmulator(options: CreateEmulatorOptions = {}): Promise<EmulatorHandle> {
  const host = options.host ?? '127.0.0.1';
  const registry = new ScriptRegistry();

  const server: Server = createServer((req, res) => {
    void route(req, res, registry);
  });

  server.listen(0, host);
  await once(server, 'listening');

  const addr = server.address() as AddressInfo;
  const url = `http://${host}:${addr.port}`;

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // Force-close active sockets so failure-injection tests that leave
    // connections half-open don't hang `server.close()`.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return {
    url,
    port: addr.port,
    registry,
    stop,
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ScriptRegistry,
): Promise<void> {
  try {
    const pathname = parsePathname(req.url ?? '/');
    if (req.method === 'POST' && pathname === '/v1/messages') {
      await handleAnthropicMessages(req, res, registry);
      return;
    }
    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      await handleOpenAIChatCompletions(req, res, registry);
      return;
    }
    if (!res.headersSent) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            type: 'not_found',
            message: `Emulator does not implement ${req.method} ${pathname}`,
          },
        }),
      );
    }
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            type: 'emulator_internal_error',
            message: (err as Error).message,
          },
        }),
      );
    } else {
      res.socket?.destroy();
    }
  }
}

function parsePathname(rawUrl: string): string {
  // The agent SDK sends `POST /v1/messages?beta=true`. We MUST tolerate the
  // query string. The WHATWG URL parser needs a base, but we only care about
  // the pathname here so any base will do.
  try {
    return new URL(rawUrl, 'http://emulator.invalid').pathname;
  } catch {
    // Fallback for very malformed URLs: lop off the query string by hand.
    const q = rawUrl.indexOf('?');
    return q === -1 ? rawUrl : rawUrl.slice(0, q);
  }
}

export type { ScriptEntry };
export {
  ScriptRegistry,
  computePromptHash,
  canonicalizeRequest,
  entryWire,
  isAnthropicEntry,
  isOpenAIEntry,
  type WireFormat,
  type AnthropicResponse,
  type AnthropicContentBlock,
  type AnthropicStopReason,
  type AnthropicScriptEntry,
  type AnthropicFailureMode,
  type OpenAIResponse,
  type OpenAIFinishReason,
  type OpenAIToolCall,
  type OpenAIScriptEntry,
  type OpenAIFailureMode,
  type FailureMode,
  type StreamControl,
} from './script-engine.js';
export { buildOpenAIChunks, serializeOpenAIChunk, SSE_DONE } from './openai.js';
