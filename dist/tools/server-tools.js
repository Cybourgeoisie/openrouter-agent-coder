import { SDKHooks } from '@openrouter/sdk/hooks/hooks';
export const SERVER_TOOLS = [
    { type: 'openrouter:datetime' },
    { type: 'openrouter:web_search' },
    { type: 'openrouter:web_fetch' },
];
export function createServerToolsHooks() {
    const hooks = new SDKHooks();
    hooks.registerBeforeCreateRequestHook({
        beforeCreateRequest(_context, input) {
            if (!input.options?.body || typeof input.options.body !== 'string')
                return input;
            try {
                const body = JSON.parse(input.options.body);
                if (Array.isArray(body.tools)) {
                    body.tools.push(...SERVER_TOOLS);
                }
                else {
                    body.tools = [...SERVER_TOOLS];
                }
                return { ...input, options: { ...input.options, body: JSON.stringify(body) } };
            }
            catch {
                return input;
            }
        },
    });
    return hooks;
}
//# sourceMappingURL=server-tools.js.map