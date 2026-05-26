import { z } from 'zod/v4';
import { type ToolContext } from './context.js';
export declare const MAX_TIMEOUT_MS = 600000;
export interface RunCommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}
export declare function runCommandTool(ctx?: ToolContext): import("@openrouter/agent").ToolWithExecute<z.ZodObject<{
    command: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    timeout_ms: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.core.$ZodType<RunCommandResult, unknown, z.core.$ZodTypeInternals<RunCommandResult, unknown>>, Record<string, unknown>>;
//# sourceMappingURL=run-command.d.ts.map