#!/usr/bin/env node

import 'dotenv/config';
import { createInterface } from 'node:readline';
import { createAgent, runPrompt } from './agent.js';
import { createSessionId, logSessionStart } from './logging/logger.js';
import { getLastSession } from './logging/session-registry.js';

async function resolveSessionId(): Promise<{ sessionId: string; resumed: boolean }> {
  // Honour explicit OR_SESSION_ID env-var first (original behaviour).
  if (process.env.OR_SESSION_ID) {
    return { sessionId: process.env.OR_SESSION_ID, resumed: false };
  }

  // Strip --continue from argv and check if it was present.
  const rawArgs = process.argv.slice(2);
  const continueIdx = rawArgs.indexOf('--continue');
  if (continueIdx !== -1) {
    rawArgs.splice(continueIdx, 1);
    // Mutate argv so the rest of the CLI only sees the prompt args.
    process.argv = [...process.argv.slice(0, 2), ...rawArgs];

    const last = await getLastSession();
    if (last) {
      return { sessionId: last.sessionId, resumed: true };
    }
    // No previous session found — fall through and start fresh.
    console.warn('No previous session found — starting a new session.\n');
  }

  return { sessionId: createSessionId(), resumed: false };
}

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('Error: OPENROUTER_API_KEY environment variable is required.');
    process.exit(1);
  }

  const { sessionId, resumed } = await resolveSessionId();
  const session = createAgent(sessionId);

  await logSessionStart(sessionId);

  const singlePrompt = process.argv.slice(2).join(' ').trim();

  if (singlePrompt) {
    if (resumed) {
      console.log(`Continuing session: ${sessionId}\n`);
    }
    await executePrompt(session, singlePrompt);
    return;
  }

  if (!process.stdin.isTTY) {
    const chunks: string[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(String(chunk));
    }
    const input = chunks.join('').trim();
    if (input) {
      if (resumed) {
        console.log(`Continuing session: ${sessionId}\n`);
      }
      await executePrompt(session, input);
    }
    return;
  }

  if (resumed) {
    console.log(`Continuing session: ${sessionId}`);
  } else {
    console.log(`or-coder session: ${sessionId}`);
  }
  console.log('Type your prompt (Ctrl+D to exit)\n');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    rl.pause();
    await executePrompt(session, input);
    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\nGoodbye.');
    process.exit(0);
  });
}

async function executePrompt(session: ReturnType<typeof createAgent>, prompt: string): Promise<void> {
  try {
    // Print a leading newline to separate the prompt echo from the response.
    process.stdout.write('\n');

    const result = await runPrompt(session, prompt, (delta) => {
      process.stdout.write(delta);
    });

    // ── Turn / cost summary ─────────────────────────────────────────────────
    // Printed after every response so the user always knows where they stand.
    const { model, turnCount, promptCost, totalCost } = result;
    const turnLabel = turnCount === 0 ? '1 turn' : `${turnCount + 1} turns`;
    const fmtCost = (n: number) =>
      n === 0 ? '$0.000000' : `${n.toFixed(6)}`;
    process.stdout.write(
      `\n╌╌ ${model} · ${turnLabel} · prompt: ${fmtCost(promptCost)} · session: ${fmtCost(totalCost)} ╌╌\n`,
    );
  } catch (err) {
    console.error('\nError:', err instanceof Error ? err.message : err);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
