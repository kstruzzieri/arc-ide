/**
 * Extracts the body of the first `selector { ... }` block in a stylesheet.
 *
 * jsdom resolves no CSS from a module, so stylesheet guards read the file and
 * assert on declarations directly. Comments are stripped first: a comment can
 * carry the very text an assertion looks for, and a `}` inside one would
 * truncate the body. The selector must start a line, so `.dialog` cannot bind
 * to `.dialogTitle` or `.dialog::backdrop`.
 *
 * Ceiling: `[^}]*` also stops at a `}` inside a string or url(), and only the
 * first block for the selector is returned; a later block for the same
 * selector would win the cascade unseen.
 */
export function cssRule(source: string, selector: string): string {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = stripped.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1];
  if (!body) throw new Error(`Missing CSS rule ${selector}`);
  return body;
}
