/**
 * Compile a path-style glob into an anchored regex.
 *
 * - Double-star matches any sequence including path separators (greedy).
 * - Double-star followed by a slash is the recursive segment wildcard —
 *   the leading directory chain is OPTIONAL. So a pattern of the form
 *   globstar-slash-X matches both `X` (top-level) and `dir1/dir2/X`,
 *   matching the standard glob semantics used by gitignore, minimatch,
 *   and bash globstar.
 * - Single `*` matches any sequence except slash (single-segment wildcard).
 * - `?` matches a single non-slash character.
 * - `[...]` is a character class — passed through to the regex; supports
 *   ranges (`[a-z]`) and negation via `[!...]` (translated to `[^...]`).
 *   An unmatched opening `[` is treated as a literal.
 * - Other regex metacharacters are escaped.
 *
 * Used by `compileRule` for `Edit(...)` / `Read(...)` / `Write(...)` /
 * `List(...)` / `Grep(...)` scoped rules, `grep_files`'s in-tree filename
 * filter, and the `glob` tool's recursive path matcher.
 *
 * `?`, `[...]`, and globstar-slash zero-or-more-segments support were added
 * for the `glob` tool (Phase 3.11). Patterns without those features compile
 * to the same regex as before. Patterns using globstar-slash now also match
 * the zero-segment case (e.g. `src/<<globstar>>/agent.ts` matches
 * `src/agent.ts`), which is the standard glob semantic.
 */
export function compileGlobToRegex(pattern: string): RegExp {
  let body = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        body += '(?:.*/)?';
        i += 3;
      } else {
        body += '.*';
        i += 2;
      }
    } else if (c === '*') {
      body += '[^/]*';
      i += 1;
    } else if (c === '?') {
      body += '[^/]';
      i += 1;
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        body += '\\[';
        i += 1;
      } else {
        let cls = pattern.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        body += '[' + cls + ']';
        i = end + 1;
      }
    } else if (/[.+^${}()|\\]/.test(c)) {
      body += '\\' + c;
      i += 1;
    } else {
      body += c;
      i += 1;
    }
  }
  return new RegExp('^' + body + '$');
}
