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
export declare function accountInfo(opts: {
    apiKey: string;
    baseUrl?: string;
}): Promise<AccountInfo | null>;
export declare function supportedModels(opts: {
    apiKey: string;
    baseUrl?: string;
}): Promise<ModelInfo[]>;
//# sourceMappingURL=openrouter-api.d.ts.map