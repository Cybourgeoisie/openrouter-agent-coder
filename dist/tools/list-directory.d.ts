import { z } from 'zod/v4';
import { type ToolContext } from './context.js';
export declare function listDirectoryTool(ctx?: ToolContext): import("@openrouter/agent").ToolWithExecute<z.ZodObject<{
    path: z.ZodDefault<z.ZodString>;
}, z.core.$strip>, z.core.$ZodType<{
    path: string;
    entries: string[];
}, unknown, z.core.$ZodTypeInternals<{
    path: string;
    entries: string[];
}, unknown>>, Record<string, unknown>>;
//# sourceMappingURL=list-directory.d.ts.map