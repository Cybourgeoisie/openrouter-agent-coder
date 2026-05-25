/**
 * Phase 5.6 — public slash-command surface. Re-exports the spec types and
 * discovery loader as a single import path.
 */

export type { CommandInfo, CommandFrontmatter, CommandSource } from './spec.js';
export { createCommandLoader, parseCommandFile, COMMAND_NAMESPACE_SEPARATOR } from './loader.js';
export type {
  CommandLoader,
  CommandLoaderOptions,
  ResolveContext,
  ResolvedCommand,
} from './loader.js';
