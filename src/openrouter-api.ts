const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export interface AccountInfo {
  provider: 'openrouter';
  label: string;
  usageUsd: number;
  limitUsd: number | null;
}

export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
}

interface AuthKeyResponse {
  data?: {
    label?: string;
    usage?: number;
    limit?: number | null;
  };
}

interface ModelsResponse {
  data?: Array<{
    id?: string;
    name?: string;
    description?: string;
  }>;
}

function buildHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  };
}

function errorMessage(url: string, res: Response): string {
  return `Request to ${url} failed: ${res.status} ${res.statusText}`;
}

export async function accountInfo(opts: {
  apiKey: string;
  baseUrl?: string;
}): Promise<AccountInfo | null> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const url = `${baseUrl}/auth/key`;
  const res = await fetch(url, { headers: buildHeaders(opts.apiKey) });

  if (res.status === 401 || res.status === 403) {
    return null;
  }
  if (!res.ok) {
    throw new Error(errorMessage(url, res));
  }

  const body = (await res.json()) as AuthKeyResponse;
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

export async function supportedModels(opts: {
  apiKey: string;
  baseUrl?: string;
}): Promise<ModelInfo[]> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const url = `${baseUrl}/models`;
  const res = await fetch(url, { headers: buildHeaders(opts.apiKey) });

  if (!res.ok) {
    throw new Error(errorMessage(url, res));
  }

  const body = (await res.json()) as ModelsResponse;
  const entries = Array.isArray(body.data) ? body.data : [];

  return entries
    .filter(
      (m): m is { id: string; name?: string; description?: string } =>
        typeof m?.id === 'string' && m.id.length > 0,
    )
    .map((m) => ({
      value: m.id,
      displayName: typeof m.name === 'string' && m.name.length > 0 ? m.name : m.id,
      description: typeof m.description === 'string' ? m.description : '',
    }));
}
