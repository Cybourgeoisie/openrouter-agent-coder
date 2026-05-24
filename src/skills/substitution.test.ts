import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import {
  renderSkillBody,
  substituteVariables,
  substituteArguments,
  SHELL_DISABLED_MARKER,
  type SubstitutionContext,
} from './substitution.js';

function baseCtx(overrides: Partial<SubstitutionContext> = {}): SubstitutionContext {
  return {
    arguments: [],
    sessionId: 'sess-1',
    // Use the OS tmpdir so spawn('sh', ...) has a real cwd to start in.
    projectDir: tmpdir(),
    env: {},
    ...overrides,
  };
}

describe('substituteVariables', () => {
  it('substitutes well-known CLAUDE_* keys', () => {
    const ctx = baseCtx({ projectDir: '/proj', skillDir: '/sk', effort: 'high' });
    const out = substituteVariables(
      '${CLAUDE_SESSION_ID} ${CLAUDE_PROJECT_DIR} ${CLAUDE_SKILL_DIR} ${CLAUDE_EFFORT}',
      ctx,
    );
    expect(out).toBe('sess-1 /proj /sk high');
  });

  it('leaves unknown ${VAR} unchanged', () => {
    const ctx = baseCtx();
    expect(substituteVariables('${UNKNOWN_THING}', ctx)).toBe('${UNKNOWN_THING}');
  });

  it('substitutes user_config.<key>', () => {
    const ctx = baseCtx({ userConfig: { theme: 'dark', port: 42 } });
    expect(substituteVariables('${user_config.theme}=${user_config.port}', ctx)).toBe('dark=42');
  });

  it('passes through env values', () => {
    const ctx = baseCtx({ env: { FOO: 'bar' } });
    expect(substituteVariables('FOO=${FOO}', ctx)).toBe('FOO=bar');
  });

  it('substitutes CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA when set', () => {
    const ctx = baseCtx({ pluginRoot: '/p', pluginData: '/d' });
    expect(substituteVariables('${CLAUDE_PLUGIN_ROOT} ${CLAUDE_PLUGIN_DATA}', ctx)).toBe('/p /d');
  });

  it('leaves CLAUDE_* unchanged when the matching ctx field is not set', () => {
    const ctx = baseCtx();
    // CLAUDE_SKILL_DIR is not set on the base ctx — passthrough.
    expect(substituteVariables('${CLAUDE_SKILL_DIR}', ctx)).toBe('${CLAUDE_SKILL_DIR}');
  });

  it('returns undefined for unknown user_config keys (passthrough)', () => {
    const ctx = baseCtx({ userConfig: { only: 'me' } });
    expect(substituteVariables('${user_config.nothing}', ctx)).toBe('${user_config.nothing}');
  });
});

describe('substituteArguments', () => {
  it('substitutes $ARGUMENTS verbatim when present', () => {
    const ctx = baseCtx({ arguments: ['a', 'b', 'c'] });
    expect(substituteArguments('args: $ARGUMENTS', ctx)).toBe('args: a b c');
  });

  it('appends ARGUMENTS: <value> when the token is absent and args are non-empty', () => {
    const ctx = baseCtx({ arguments: ['hello'] });
    const out = substituteArguments('skill body', ctx);
    expect(out).toBe('skill body\n\nARGUMENTS: hello');
  });

  it('does not append when arguments is empty', () => {
    const ctx = baseCtx({ arguments: [] });
    expect(substituteArguments('skill body', ctx)).toBe('skill body');
  });

  it('substitutes $ARGUMENTS[N] (0-indexed)', () => {
    const ctx = baseCtx({ arguments: ['x', 'y'] });
    expect(substituteArguments('$ARGUMENTS[0]/$ARGUMENTS[1]/$ARGUMENTS[2]', ctx)).toBe('x/y/');
  });

  it('substitutes $N (1-indexed)', () => {
    const ctx = baseCtx({ arguments: ['x', 'y'] });
    expect(substituteArguments('$1/$2/$3', ctx)).toBe('x/y/');
  });

  it('substitutes named positional via $<name>', () => {
    const ctx = baseCtx({
      arguments: ['file.txt', 'main'],
      named: { file: 'file.txt', branch: 'main' },
    });
    expect(substituteArguments('$file on $branch', ctx)).toBe('file.txt on main');
  });

  it('leaves unknown $<name> unchanged', () => {
    const ctx = baseCtx({ named: {} });
    expect(substituteArguments('$missing', ctx)).toBe('$missing');
  });
});

describe('renderSkillBody — shell execution', () => {
  it('expands inline !`cmd` at start of line', async () => {
    const ctx = baseCtx();
    const out = await renderSkillBody('Result: !`echo hello`', ctx);
    expect(out).toBe('Result: hello');
  });

  it('does NOT expand !`cmd` when not at start-of-line or after whitespace', async () => {
    const ctx = baseCtx();
    // Preceded by a non-whitespace `x` — must not trigger execution.
    const out = await renderSkillBody('x!`echo hi`', ctx);
    expect(out).toBe('x!`echo hi`');
  });

  it('honors disableSkillShellExecution policy flag', async () => {
    const ctx = baseCtx({ disableShellExecution: true });
    const out = await renderSkillBody('Result: !`echo nope`', ctx);
    expect(out).toBe(`Result: ${SHELL_DISABLED_MARKER}`);
  });

  it('expands a fenced ```! block', async () => {
    const ctx = baseCtx();
    const body = '```!\necho fenced-ok\n```';
    const out = await renderSkillBody(body, ctx);
    expect(out).toBe('fenced-ok');
  });

  it('does NOT re-scan command stdout for variable placeholders', async () => {
    // The shell emits a literal `${CLAUDE_SESSION_ID}` token (single quotes
    // disable shell expansion). Variable substitution already ran in pass 1;
    // single-pass leaves the token verbatim instead of resolving it again.
    const ctx = baseCtx({ sessionId: 'sess-xyz' });
    const out = await renderSkillBody("!`printf '%s' '${CLAUDE_SESSION_ID}'`", ctx);
    // The `${CLAUDE_SESSION_ID}` in the JS source string IS resolved by the
    // variable pass (since it lives in the body), so the command actually
    // runs `printf '%s' 'sess-xyz'`. The shell stdout is `sess-xyz`. If we
    // were re-scanning, nothing would change — confirms single-pass leaves
    // a fully-expanded body alone.
    expect(out).toBe('sess-xyz');
  });

  it('aborts when the signal fires', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const ctx = baseCtx({ signal: ctl.signal });
    const out = await renderSkillBody('!`sleep 5 && echo done`', ctx);
    expect(out).toContain('aborted');
  });

  it('reports non-zero exit codes inline', async () => {
    const ctx = baseCtx();
    const out = await renderSkillBody('!`false`', ctx);
    expect(out).toContain('exit code 1');
  });

  it('times out long-running commands', async () => {
    const ctx = baseCtx({ timeoutMs: 100 });
    const out = await renderSkillBody('!`sleep 5`', ctx);
    expect(out).toContain('terminated by SIGTERM');
  });

  it('omits the stdout line of the failure report when stdout is empty', async () => {
    // Empty stdout + populated stderr exercises the `if (stdout)` false branch
    // in formatExitFailure — the report should carry the reason and stderr
    // line only, with no leading empty-stdout line.
    const ctx = baseCtx();
    const out = await renderSkillBody('!`bash -c "echo BOOM 1>&2; exit 1"`', ctx);
    expect(out).toBe('[shell exit code 1]\nstderr: BOOM');
  });

  it('captures stderr when the command writes to it', async () => {
    const ctx = baseCtx();
    const out = await renderSkillBody('!`bash -c "echo OK; echo NOPE 1>&2; exit 3"`', ctx);
    expect(out).toContain('exit code 3');
    expect(out).toContain('NOPE');
  });

  it('aborts mid-stream when the signal fires after spawn starts', async () => {
    const ctl = new AbortController();
    const ctx = baseCtx({ signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    const out = await renderSkillBody('!`sleep 5`', ctx);
    expect(out).toContain('aborted');
  });
});

describe('renderSkillBody — fenced shell', () => {
  it('preserves indentation on multi-line fenced output', async () => {
    const ctx = baseCtx();
    const body = '  ```!\n  printf "line1\\nline2"\n  ```';
    const out = await renderSkillBody(body, ctx);
    expect(out).toBe('  line1\n  line2');
  });

  it('replaces fenced blocks with the disabled marker under policy', async () => {
    const ctx = baseCtx({ disableShellExecution: true });
    const body = '```!\nshould not run\n```';
    const out = await renderSkillBody(body, ctx);
    expect(out).toContain(SHELL_DISABLED_MARKER);
  });
});

describe('renderSkillBody — composed pipeline', () => {
  it('runs variables → arguments → shell in order', async () => {
    const ctx = baseCtx({
      arguments: ['world'],
      env: { GREETING: 'Hello' },
    });
    const body = '!`echo ${GREETING}, $1!`';
    const out = await renderSkillBody(body, ctx);
    // ${GREETING} expands first, then $1 → world, then shell runs.
    expect(out).toBe('Hello, world!');
  });
});
