import { SDKHooks } from '@openrouter/sdk/hooks/hooks';
import type { BeforeCreateRequestContext } from '@openrouter/sdk/hooks/types';

export const SERVER_TOOLS = [
  { type: 'openrouter:datetime' as const },
  { type: 'openrouter:web_search' as const },
  { type: 'openrouter:web_fetch' as const },
];

export function createServerToolsHooks(): SDKHooks {
  const hooks = new SDKHooks();
  hooks.registerBeforeCreateRequestHook({
    beforeCreateRequest(
      _context: BeforeCreateRequestContext,
      input: { url: URL; options?: RequestInit },
    ) {
      if (!input.options?.body || typeof input.options.body !== 'string') return input;

      try {
        const body = JSON.parse(input.options.body);
        if (Array.isArray(body.tools)) {
          body.tools.push(...SERVER_TOOLS);
        } else {
          body.tools = [...SERVER_TOOLS];
        }
        return { ...input, options: { ...input.options, body: JSON.stringify(body) } };
      } catch {
        return input;
      }
    },
  });
  return hooks;
}
