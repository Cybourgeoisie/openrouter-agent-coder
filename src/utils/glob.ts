/**
 * Compile a path-style glob into an anchored regex.
 *
 * - `**` matches any sequence including path separators.
 * - `*` matches any sequence except `/` (single-segment wildcard).
 * - Other regex metacharacters are escaped.
 *
 * Used by {@link compileRule} for `Edit(...)` / `Read(...)` / `Write(...)` /
 * `List(...)` / `Grep(...)` scoped rules, and by `grep_files`'s in-tree
 * filename filter (where the input is a basename and the `[^/]*` vs `.*`
 * distinction is irrelevant).
 */
export function compileGlobToRegex(pattern: string): RegExp {
  const body = pattern
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp('^' + body + '$');
}
