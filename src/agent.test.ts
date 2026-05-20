import { describe, it, expect, vi } from 'vitest';
import { createAgent } from './agent.js';

describe('createAgent', () => {
  it('returns an AgentSession with the given sessionId', () => {
    const session = createAgent('sess_test-123');
    expect(session.sessionId).toBe('sess_test-123');
    expect(session.client).toBeDefined();
  });

  it('creates an OpenRouter client instance', () => {
    const session = createAgent('sess_abc');
    expect(typeof session.client.callModel).toBe('function');
  });

  it('different sessions get different client instances', () => {
    const s1 = createAgent('sess_1');
    const s2 = createAgent('sess_2');
    expect(s1.client).not.toBe(s2.client);
  });
});
