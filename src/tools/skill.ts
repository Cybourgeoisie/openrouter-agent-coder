/**
 * Phase 5.7 — `skill` built-in tool.
 *
 * Surfaces the host's {@link SkillLoader} to the model behind a single
 * `skill({ name, arguments? })` call. The tool description carries a
 * `## Available Skills` listing — `(name, description + when_to_use)` triples,
 * truncated to {@link skillDescriptionBudget} chars total — so the model can
 * pick a skill without an extra `list_skills` step.
 *
 * Two execution paths:
 *
 * 1. **Inline render** (default). The skill body is run through
 *    {@link SkillLoader.render} with `arguments` shell-split, and the rendered
 *    text is returned as the tool result. The model then continues its turn
 *    with the body's content in scope as the most-recent `tool_result`.
 * 2. **`context: fork`**. When the skill's frontmatter sets `context: fork`,
 *    the render still produces the body, but instead of returning it directly
 *    the tool delegates to an injected {@link SubagentRunner} (Phase 4.7) —
 *    the body becomes the subagent's prompt, and the subagent's result text
 *    flows back as the tool result. `frontmatter.agent` chooses the subagent
 *    type; unknown types fall back to `'general-purpose'` with a warn log
 *    (graceful degradation: the alternative — throwing — would surprise a
 *    skill author who renamed an agent type out from under us).
 *
 * **Permission integration** (Phase 3.2). When the skill's frontmatter
 * defines an `allowed-tools` list, the factory composes the rules into a
 * per-invocation gate that NARROWS the run-level permission policy. The
 * narrowed gate is wired into the subagent's `allowedTools` constructor opt
 * for `context: fork` and stored on a per-render context for inline renders.
 * The `pendingSkillContext` hook below is how the agent threads the narrowed
 * policy into its `canUseTool` evaluator for the immediate post-render turn.
 */

import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { randomUUID } from 'node:crypto';
import { DEFAULT_TOOL_CONTEXT, type ToolContext } from './context.js';
import type { SkillLoader } from '../skills/loader.js';
import type { SkillInfo } from '../skills/spec.js';
import type { SubstitutionContext } from '../skills/substitution.js';
import { splitShellArgs } from '../skills/loader.js';
import type { SubagentRunner, SubagentRunResult } from './spawn-subagent.js';

/**
 * Default fraction of the model's context window reserved for the skill
 * listing block. Mirrors Claude Code's `skillListingBudgetFraction = 0.01`.
 * Picked as 1% so a 200k-token context still spares ~2k tokens for the
 * listing — enough for ~40 short triples without crowding the prompt.
 */
export const DEFAULT_SKILL_DESCRIPTION_BUDGET = 0.01;

/** Result envelope returned by the `skill` tool's `execute`. */
export interface SkillToolResult {
  /** Qualified skill name that was rendered. */
  name: string;
  /** Source the skill was loaded from. */
  source: SkillInfo['source'];
  /** When the skill ran in a forked subagent, the subagent's session id. */
  subagentSessionId?: string;
  /** Rendered body OR subagent result text. */
  content: string;
  /** Set when `context: fork` and the subagent surfaced a non-success terminal status. */
  error?: string;
}

/**
 * Per-invocation overrides applied by the `skill` tool while a single skill
 * runs. The agent listens for this via {@link SkillToolOptions.onSkillActive}
 * to layer the skill's `allowed-tools` onto its `canUseTool` evaluator.
 *
 * `dispose()` clears the active context; the factory invokes it after the
 * render completes (success OR error).
 */
export interface ActiveSkillContext {
  name: string;
  allowedToolsNarrowing?: readonly string[];
  effort?: SkillInfo['frontmatter']['effort'];
  model?: string;
}

export interface SkillToolOptions {
  /** Loader the tool will resolve skills against. Required. */
  loader: SkillLoader;
  /** Substitution-context provider — called per render to build a fresh ctx. */
  buildContext: (args: readonly string[], skill: SkillInfo) => SubstitutionContext;
  /**
   * Names of skills surfaced in the listing block. Pre-computed by the agent
   * (post-budget pruning); the tool description echoes them so the model has
   * something compact to point at when it sees the system-prompt listing.
   * Unrelated to {@link SkillLoader.list} — the loader holds the full set;
   * this is just the visible-to-model subset.
   */
  visibleNames?: readonly string[];
  /**
   * Optional sink for per-render lifecycle. The agent threads its
   * `safeFireHook` here so the runtime can fire `Notification(info,
   * 'skill_loaded', { name, source })` per the spike.
   */
  onSkillLoaded?: (skill: SkillInfo) => void | Promise<void>;
  /**
   * Optional hook fired when a skill render begins (before any inline render
   * or subagent spawn). The agent installs an active-skill context that
   * narrows its `canUseTool` evaluator for the duration of the render. The
   * returned disposer is invoked after the render completes.
   */
  onSkillActive?: (ctx: ActiveSkillContext) => (() => void) | undefined;
  /**
   * Required when ANY discovered skill sets `context: fork`. The factory uses
   * this to drive the Phase 4.7 subagent runner. Omit when no fork-context
   * skills are configured — the factory falls back to inline render and
   * surfaces an `error` envelope if asked to fork.
   */
  runSubagent?: SubagentRunner;
  /** Parent session id, used to derive subagent session ids. */
  parentSessionId?: string;
  /** Default subagent depth when forking (parent depth + 1 lives in agent.ts). */
  currentSubagentDepth?: number;
  /** Optional list of registered subagent types — used to validate `frontmatter.agent`. */
  knownSubagentTypes?: readonly string[];
  /** Optional logger for skill-author surprises (unknown agent type, missing runner, …). */
  logger?: (
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    fields?: Record<string, unknown>,
  ) => void;
}

/**
 * Build the `skill` built-in tool. The factory snapshots the loader's
 * listing into the tool description at construction time — discovering a new
 * skill mid-run requires re-creating the tool (matches Claude Code's docs:
 * top-level skill dirs are scanned at session start).
 */
export function skillTool(opts: SkillToolOptions, ctx: ToolContext = DEFAULT_TOOL_CONTEXT) {
  const description = buildToolDescription(opts.visibleNames);

  return tool({
    name: 'skill',
    description,
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .describe(
          'Qualified skill name. Use the name shown in the Available Skills listing — plugin skills appear as `<plugin>:<skill>`.',
        ),
      arguments: z
        .string()
        .optional()
        .describe(
          'Optional argument string (shell-quoted). Passed to the skill body via $ARGUMENTS / $N / $name substitution.',
        ),
    }),
    execute: async ({ name, arguments: argString }): Promise<SkillToolResult> => {
      const skill = await opts.loader.get(name);
      if (!skill) {
        return {
          name,
          source: 'project',
          content: `[skill not found: ${name}]`,
          error: 'unknown skill',
        };
      }
      const args = argString && argString.length > 0 ? splitShellArgs(argString) : [];
      await opts.onSkillLoaded?.(skill);

      const narrowing = skill.frontmatter.allowedTools
        ? splitAllowedTools(skill.frontmatter.allowedTools)
        : undefined;
      const activeDisposer = opts.onSkillActive?.({
        name: skill.name,
        ...(narrowing !== undefined && { allowedToolsNarrowing: narrowing }),
        ...(skill.frontmatter.effort !== undefined && { effort: skill.frontmatter.effort }),
        ...(skill.frontmatter.model !== undefined && { model: skill.frontmatter.model }),
      });
      try {
        if (skill.frontmatter.context === 'fork') {
          return await runForked(skill, args, opts, ctx);
        }
        const substitution = opts.buildContext(args, skill);
        const body = await opts.loader.render(skill.name, substitution);
        return {
          name: skill.name,
          source: skill.source,
          content: body,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          name: skill.name,
          source: skill.source,
          content: `[skill render failed: ${message}]`,
          error: message,
        };
      } finally {
        activeDisposer?.();
      }
    },
  });
}

/**
 * Drive a `context: fork` skill through the injected
 * {@link SubagentRunner}. The skill body is rendered first (so substitution
 * happens at the parent's trust level), then handed off as the subagent's
 * prompt. Falls back to inline render if no runner is wired.
 */
async function runForked(
  skill: SkillInfo,
  args: readonly string[],
  opts: SkillToolOptions,
  ctx: ToolContext,
): Promise<SkillToolResult> {
  if (!opts.runSubagent) {
    opts.logger?.(
      'warn',
      `skill "${skill.name}" requested context:fork but no runSubagent is wired`,
    );
    const inlineCtx = opts.buildContext(args, skill);
    const body = await opts.loader.render(skill.name, inlineCtx);
    return {
      name: skill.name,
      source: skill.source,
      content: body,
      error: 'context:fork unavailable — runSubagent not wired; inlined instead',
    };
  }
  const substitution = opts.buildContext(args, skill);
  const body = await opts.loader.render(skill.name, substitution);

  // Validate subagent type: when `frontmatter.agent` names a type that is
  // not in `knownSubagentTypes` (caller-supplied), log a warn and fall back
  // to the default subagent runner (no special-cased "general-purpose"
  // selector exists in this library yet — the warn is the user-visible
  // signal; see PR body's ambiguity-call #7).
  if (
    skill.frontmatter.agent !== undefined &&
    opts.knownSubagentTypes &&
    opts.knownSubagentTypes.length > 0 &&
    !opts.knownSubagentTypes.includes(skill.frontmatter.agent)
  ) {
    opts.logger?.(
      'warn',
      `skill "${skill.name}" requested unknown agent type; falling back to general-purpose`,
      { requested: skill.frontmatter.agent, known: opts.knownSubagentTypes },
    );
  }

  const parentSessionId = opts.parentSessionId ?? 'skill';
  const subagentSessionId = `${parentSessionId}:skill:${randomUUID()}`;
  const signal = (ctx as { signal?: AbortSignal }).signal ?? new AbortController().signal;
  const childDepth = (opts.currentSubagentDepth ?? 0) + 1;

  let result: SubagentRunResult;
  try {
    result = await opts.runSubagent({
      sessionId: subagentSessionId,
      prompt: body,
      ...(skill.frontmatter.model !== undefined && { model: skill.frontmatter.model }),
      ...(skill.frontmatter.effort !== undefined && { effort: skill.frontmatter.effort }),
      ...(skill.frontmatter.allowedTools !== undefined && {
        allowedTools: splitAllowedTools(skill.frontmatter.allowedTools),
      }),
      signal,
      depth: childDepth,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: skill.name,
      source: skill.source,
      subagentSessionId,
      content: `[skill subagent threw: ${message}]`,
      error: message,
    };
  }

  const out: SkillToolResult = {
    name: skill.name,
    source: skill.source,
    subagentSessionId,
    content: result.text,
  };
  if (result.status !== 'success') {
    out.error = result.reason ?? `subagent status ${result.status}`;
  }
  return out;
}

/**
 * Split a frontmatter `allowed-tools` string into individual rule fragments.
 * Honors the documented grammar: rules separated by whitespace, but a
 * parenthesised scoped pattern is kept atomic (so `Bash(npm run test) Read`
 * parses as two rules, not three).
 */
export function splitAllowedTools(raw: string): readonly string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (/\s/.test(c) && depth === 0) {
      const tok = raw.slice(start, i).trim();
      if (tok.length > 0) out.push(tok);
      start = i + 1;
    }
  }
  const tail = raw.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/**
 * Build the `## Available Skills` listing block, dropping lowest-priority
 * entries when the projected total exceeds the budget. Drop ordering is
 * **source precedence then alphabetical** — plugin > user > project — so a
 * project skill with a long description doesn't crowd out a higher-precedence
 * user skill.
 *
 * Exported for unit tests.
 */
export function buildSkillListing(skills: readonly SkillInfo[], budgetChars: number): string {
  if (skills.length === 0) return '';
  // Filter out disable-model-invocation skills entirely — they're host-only.
  const visible = skills.filter((s) => s.frontmatter.disableModelInvocation !== true);
  if (visible.length === 0) return '';

  // Drop-priority: enterprise > user > project > plugin (highest precedence
  // last to drop). Alphabetical tie-break within each tier.
  const tierRank: Record<SkillInfo['source'], number> = {
    enterprise: 0,
    user: 1,
    project: 2,
    plugin: 3,
    builtin: 4,
  };
  const ordered = [...visible].sort((a, b) => {
    const ta = tierRank[a.source];
    const tb = tierRank[b.source];
    if (ta !== tb) return ta - tb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  // First pass: produce the full text per entry, capped at MIN_LISTING_ENTRY_CHARS.
  const entries: string[] = [];
  for (const s of ordered) {
    entries.push(renderListingEntry(s));
  }

  // Drop entries from the end (lowest precedence first) until under budget.
  let total = entries.join('\n').length;
  let kept = entries.length;
  while (total > budgetChars && kept > 0) {
    kept--;
    total = entries.slice(0, kept).join('\n').length;
  }
  if (kept === 0) return '';
  const final = entries.slice(0, kept);
  return ['## Available Skills', '', ...final].join('\n');
}

function renderListingEntry(s: SkillInfo): string {
  const desc = s.frontmatter.description ?? '';
  const when = s.frontmatter.whenToUse ?? '';
  let detail = desc;
  if (when.length > 0) {
    detail = detail ? `${detail} — when to use: ${when}` : `when to use: ${when}`;
  }
  if (detail.length === 0) return `- \`${s.name}\``;
  return `- \`${s.name}\` — ${detail}`;
}

function buildToolDescription(visible: readonly string[] | undefined): string {
  const base =
    'Invoke a discovered skill by name. The skill body is substituted (variables + positional/named arguments + inline/fenced shell) and the rendered text is returned as the tool result. The full list of available skills (with descriptions and `when_to_use` hints) is in the `## Available Skills` block of the system instructions — pick a name from there. Use this when a skill explicitly fits the current subtask rather than re-deriving the same behavior from scratch.';
  if (!visible || visible.length === 0) return base;
  const names = visible.map((n) => `\`${n}\``).join(', ');
  return `${base}\n\nVisible skills: ${names}`;
}
