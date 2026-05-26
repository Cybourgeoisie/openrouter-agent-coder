const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
function buildHeaders(apiKey) {
    return {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
    };
}
function errorMessage(url, res) {
    return `Request to ${url} failed: ${res.status} ${res.statusText}`;
}
export async function accountInfo(opts) {
    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    const url = `${baseUrl}/auth/key`;
    const res = await fetch(url, { headers: buildHeaders(opts.apiKey) });
    if (res.status === 401 || res.status === 403) {
        return null;
    }
    if (!res.ok) {
        throw new Error(errorMessage(url, res));
    }
    const body = (await res.json());
    const data = body.data ?? {};
    const usage = typeof data.usage === 'number' ? data.usage : 0;
    const limit = typeof data.limit === 'number' ? data.limit : null;
    const label = typeof data.label === 'string' ? data.label : '';
    return {
        provider: 'openrouter',
        label,
        usageUsd: usage,
        limitUsd: limit,
    };
}
export async function supportedModels(opts) {
    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    const url = `${baseUrl}/models`;
    const res = await fetch(url, { headers: buildHeaders(opts.apiKey) });
    if (!res.ok) {
        throw new Error(errorMessage(url, res));
    }
    const body = (await res.json());
    const entries = Array.isArray(body.data) ? body.data : [];
    return entries
        .filter((m) => typeof m?.id === 'string' && m.id.length > 0)
        .map((m) => ({
        value: m.id,
        displayName: typeof m.name === 'string' && m.name.length > 0 ? m.name : m.id,
        description: typeof m.description === 'string' ? m.description : '',
    }));
}
//# sourceMappingURL=openrouter-api.js.map