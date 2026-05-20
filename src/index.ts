#!/usr/bin/env node

import { createInterface } from 'node:readline';
import { createAgent, runPrompt } from './agent.js';
import { createSessionId, logSessionStart } from './logging/logger.js';

const sessionId = process.env.OR_SESSION_ID ?? createSessionId();
const session = createAgent(sessionId);

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('Error: OPENROUTER_API_KEY environment variable is required.');
    process.exit(1);
  }

  await logSessionStart(sessionId);

  const singlePrompt = process.argv.slice(2).join(' ').trim();

  if (singlePrompt) {
    await executePrompt(singlePrompt);
    return;
  }

  if (!process.stdin.isTTY) {
    const chunks: string[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(String(chunk));
    }
    const input = chunks.join('').trim();
    if (input) {
      await executePrompt(input);
    }
    return;
  }

  console.log(`or-coder session: ${sessionId}`);
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
    await executePrompt(input);
    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\nGoodbye.');
    process.exit(0);
  });
}

async function executePrompt(prompt: string): Promise<void> {
  try {
    // Print a leading newline to separate the prompt echo from the response.
    process.stdout.write('\n');

    await runPrompt(session, prompt, (delta) => {
      process.stdout.write(delta);
    });
  } catch (err) {
    console.error('\nError:', err instanceof Error ? err.message : err);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
