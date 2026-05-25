// One-off authoring script (Phase 6.5a). Runs each canonical scenario JSON
// in "capture" mode: any entry whose `promptHash` is still the sentinel
// "sha256:capture-me" gets resolved by intercepting the FIRST script-miss
// request that matches its wire + sequence position, computing the real
// canonical hash from the request body, and rewriting the JSON in place.
//
// Workflow: author drafts the scenario JSON with `"promptHash":
// "sha256:capture-me"` placeholders. They run this script once. The script
// drives both SDKs against the scenario, hooks the emulator registry so
// every script-miss is recorded, then writes back the JSON with the captured
// hashes substituted in entry-order per wire.
//
// Run with:
//   npx tsx scripts/capture-comparative-hashes.ts                # all scenarios
//   npx tsx scripts/capture-comparative-hashes.ts 02             # filter by name
//   npx tsx scripts/capture-comparative-hashes.ts 02 --dry-run   # capture but don't write
//
// Not checked in as a vitest test because it has no assertions and only
// runs on demand during scenario authoring. The README documents the
// workflow; this script is the workflow's beating heart.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { OpenRouterAgentRun } from '../src/agent.js';
import {
  computePromptHash,
  startEmulator,
  type EmulatorHandle,
  type WireFormat,
} from '../src/__tests__/comparative/emulator/index.js';
import { buildHarnessTools } from '../src/__tests__/comparative/scenarios/_tools.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = join(HERE, '..', 'src/__tests__/comparative/scenarios');
const CAPTURE_SENTINEL = 'sha256:capture-me';

interface RawEntry {
  wire: WireFormat;
  promptHash: string;
  turn: number;
  response: Record<string, unknown>;
  [k: string]: unknown;
}

interface RawScenario {
  name: string;
  prompt: string;
  model?: string;
  systemPrompt?: string;
  tools?: string[];
  canUseToolPolicy?: Array<{ tool: string; action: 'allow' | 'deny'; message?: string }>;
  script: RawEntry[];
  [k: string]: unknown;
}

async function captureOne(scenarioPath: string, dryRun: boolean): Promise<void> {
  const raw = readFileSync(scenarioPath, 'utf8');
  const scenario = JSON.parse(raw) as RawScenario;
  console.error(`\n=== ${scenario.name} ===`);

  // For each wire, maintain a queue of entries pending hash capture
  // (those still carrying the sentinel). Each unresolved miss pops the
  // head of the matching wire's queue and assigns it the captured hash.
  const pendingByWire = new Map<WireFormat, RawEntry[]>();
  for (const entry of scenario.script) {
    if (entry.promptHash !== CAPTURE_SENTINEL) continue;
    const list = pendingByWire.get(entry.wire) ?? [];
    list.push(entry);
    pendingByWire.set(entry.wire, list);
  }
  if ([...pendingByWire.values()].every((q) => q.length === 0)) {
    console.error('  (no capture-me sentinels — skipping)');
    return;
  }

  const captureLog: Array<{ wire: WireFormat; hash: string }> = [];
  const anthropicEmu = await startEmulator();
  const orEmu = await startEmulator();

  // Patch each emulator's registry: on miss, pop a pending entry of the
  // matching wire and register it with the just-computed hash. The next
  // identical retry then hits.
  const instrument = (emu: EmulatorHandle, wire: WireFormat): void => {
    const original = emu.registry.lookup.bind(emu.registry);
    (emu.registry as { lookup: typeof original }).lookup = (body, w) => {
      const result = original(body, w as 'anthropic');
      if ('ok' in result && result.ok) return result;
      // Miss path: try to resolve a pending entry.
      const hash = computePromptHash(body, wire);
      const queue = pendingByWire.get(wire) ?? [];
      if (queue.length === 0) return result;
      const next = queue.shift()!;
      next.promptHash = hash;
      // Register the now-resolved entry so the SDK's retry hits.
      emu.registry.register(next as unknown as Parameters<typeof emu.registry.register>[0]);
      captureLog.push({ wire, hash });
      console.error(`  [capture] ${wire} → ${hash}`);
      // Re-issue the lookup against the freshly-registered entry.
      return original(body, w as 'anthropic');
    };
  };
  instrument(anthropicEmu, 'anthropic');
  instrument(orEmu, 'openresponses');

  // Wire tools + canUseTool just like the harness does, for both SDKs.
  const anthropicTools = buildHarnessTools((scenario.tools ?? []) as never);
  const orTools = buildHarnessTools((scenario.tools ?? []) as never);
  const canUseToolPolicy = scenario.canUseToolPolicy ?? [];
  const denyByName = new Map(
    canUseToolPolicy
      .filter((r) => r.action === 'deny')
      .map((r) => [r.tool, r.message ?? 'denied'] as const),
  );

  // OR side
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 12000).unref();
    const run = new OpenRouterAgentRun({
      apiKey: 'stub',
      sessionId: `capture-${scenario.name}`,
      prompt: scenario.prompt,
      baseUrl: orEmu.url,
      persistSession: false,
      signal: ac.signal,
      tools: orTools.orTools,
      ...(scenario.model && { model: scenario.model }),
      ...(scenario.systemPrompt && { instructions: scenario.systemPrompt }),
      ...(denyByName.size > 0 && {
        canUseTool: (toolName, _input) => {
          const msg = denyByName.get(toolName);
          if (msg) return { behavior: 'deny' as const, reason: msg };
          return { behavior: 'allow' as const };
        },
      }),
    });
    for await (const _ev of run) {
      // discard
    }
  } catch (err) {
    console.error(`  OR error: ${String(err).slice(0, 200)}`);
  }

  // Anthropic side
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 12000).unref();
    const q = query({
      prompt: scenario.prompt,
      options: {
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: anthropicEmu.url,
          ANTHROPIC_API_KEY: 'sk-ant-stub',
        },
        abortController: ac,
        settingSources: [],
        ...(scenario.model && { model: scenario.model }),
        ...(scenario.systemPrompt && { systemPrompt: scenario.systemPrompt }),
        ...(anthropicTools.anthropicMcpServer && {
          mcpServers: {
            [anthropicTools.anthropicMcpServer.name]: anthropicTools.anthropicMcpServer,
          },
        }),
        ...(anthropicTools.anthropicAllowedToolNames.length > 0 && {
          allowedTools: anthropicTools.anthropicAllowedToolNames,
        }),
        ...(denyByName.size > 0 && {
          canUseTool: async (toolName: string, input: Record<string, unknown>) => {
            // The toolName the SDK passes is prefixed (`mcp__harness__rm`).
            const bare = toolName.replace(/^mcp__[A-Za-z0-9_-]+__/, '');
            const msg = denyByName.get(bare);
            if (msg) return { behavior: 'deny' as const, message: msg };
            return { behavior: 'allow' as const, updatedInput: input };
          },
        }),
      },
    });
    for await (const _msg of q) {
      // discard
    }
  } catch (err) {
    console.error(`  Anthropic error: ${String(err).slice(0, 200)}`);
  }

  await anthropicEmu.stop();
  await orEmu.stop();

  const remaining = [...pendingByWire.entries()]
    .filter(([, q]) => q.length > 0)
    .map(([wire, q]) => `${wire}:${q.length}`)
    .join(', ');
  if (remaining) console.error(`  unresolved: ${remaining}`);
  console.error(`  captured ${captureLog.length} hashes`);

  if (!dryRun && captureLog.length > 0) {
    writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2) + '\n', 'utf8');
    console.error(`  -> wrote ${scenarioPath}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const filter = args.find((a) => !a.startsWith('--'));
  const files = readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .filter((f) => !filter || f.includes(filter))
    .sort();
  for (const f of files) {
    await captureOne(join(SCENARIO_DIR, f), dryRun);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error('Probe failed:', e);
  process.exit(1);
});
