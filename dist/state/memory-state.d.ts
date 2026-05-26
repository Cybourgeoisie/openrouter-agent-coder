import type { StateAccessor } from '@openrouter/agent';
/**
 * In-memory {@link StateAccessor} matching the contract of
 * {@link createFileStateAccessor} without any filesystem I/O. Used by
 * `OpenRouterAgentRun` when the caller passes `persistSession: false` — the
 * run can still resume across iterations within a single process, but nothing
 * survives the run object being garbage-collected.
 *
 * Load returns `null` until the first save (mirroring file-state's ENOENT →
 * `null` shape); subsequent saves replace the cached object outright.
 */
export declare function createMemoryStateAccessor(): StateAccessor;
//# sourceMappingURL=memory-state.d.ts.map