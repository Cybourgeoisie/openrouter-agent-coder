import { z } from 'zod/v4';
import { type ToolContext } from './context.js';
export declare function readFileTool(ctx?: ToolContext): import("@openrouter/agent").ToolWithExecute<z.ZodObject<{
    path: z.ZodString;
    start_line: z.ZodOptional<z.ZodNumber>;
    end_line: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.core.$ZodType<{
    content: string;
    path: string;
    start_line?: undefined;
    end_line?: undefined;
    total_lines?: undefined;
} | {
    content: string;
    path: string;
    start_line: number;
    end_line: number;
    total_lines: number;
}, unknown, z.core.$ZodTypeInternals<{
    content: string;
    path: string;
    start_line?: undefined;
    end_line?: undefined;
    total_lines?: undefined;
} | {
    content: string;
    path: string;
    start_line: number;
    end_line: number;
    total_lines: number;
}, unknown>>, Record<string, unknown>>;
//# sourceMappingURL=read-file.d.ts.map