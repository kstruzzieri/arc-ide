import type { workspace } from '../wails/bindings';

/**
 * Heuristics that map a run command to the workspace its toolchain implies, so
 * profile creation can default to the right workspace and warn on an obvious
 * mismatch (e.g. a `go` command assigned to a Frontend workspace, which would
 * run in that workspace's folder with no go.mod).
 *
 * Intentionally conservative: only confident leading-token matches infer a type.
 * Unknown / wrapper commands (./run.sh, make, docker, custom) infer nothing and
 * never produce a warning.
 */

// Leading command token -> workspace type. Basename-matched, so /usr/bin/go works.
const TOKEN_TYPE: Record<string, string> = {
  go: 'go',
  npm: 'frontend',
  npx: 'frontend',
  yarn: 'frontend',
  pnpm: 'frontend',
  bun: 'frontend',
  node: 'frontend',
  python: 'python',
  python3: 'python',
  pytest: 'python',
  pip: 'python',
  pip3: 'python',
  uv: 'python',
  poetry: 'python',
};

// Only these workspace types host a single language, so a cross-language command
// is a real mismatch. project/docker/terraform/general can legitimately host any
// command, so they never warn.
const LANGUAGE_TYPES = new Set(['go', 'frontend', 'node', 'python']);

const TYPE_LABEL: Record<string, string> = {
  go: 'Go',
  frontend: 'Frontend',
  node: 'Node',
  python: 'Python',
};

function compatibleWorkspaceTypes(left: string, right: string): boolean {
  return (
    left === right || (['frontend', 'node'].includes(left) && ['frontend', 'node'].includes(right))
  );
}

/** First real command token, skipping leading `KEY=value` env assignments. */
function leadingToken(command: string): string | null {
  const parts = command.trim().split(/\s+/);
  for (const part of parts) {
    if (!part) continue;
    // Skip inline env assignments like FOO=bar (no path separator).
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(part) && !part.includes('/')) continue;
    // Basename so /usr/bin/go and ./go both reduce to "go".
    const base = part.split('/').pop() ?? part;
    return base || null;
  }
  return null;
}

/** The workspace type a command's toolchain implies, or null if unknown. */
export function inferCommandWorkspaceType(command: string): string | null {
  const token = leadingToken(command);
  if (!token) return null;
  return TOKEN_TYPE[token] ?? null;
}

/**
 * Picks the workspace a new profile should default to for `command`: the
 * non-project workspace whose type matches the command's toolchain, else
 * `fallbackId` (typically the active workspace).
 */
export function pickWorkspaceForCommand(
  command: string,
  workspaces: workspace.WorkspaceDef[],
  fallbackId: string
): string {
  const inferred = inferCommandWorkspaceType(command);
  if (!inferred) return fallbackId;
  const fallback = workspaces.find((w) => w.id === fallbackId);
  if (fallback && compatibleWorkspaceTypes(fallback.type, inferred)) return fallbackId;
  const match = workspaces.find(
    (w) => w.id !== 'project' && compatibleWorkspaceTypes(w.type, inferred)
  );
  return match ? match.id : fallbackId;
}

/**
 * A non-blocking warning when `command`'s toolchain doesn't match the selected
 * workspace, or null when there's nothing to flag. Only fires for confident
 * command inference against a single-language workspace of a different type.
 */
export function commandWorkspaceMismatch(
  command: string,
  ws: workspace.WorkspaceDef | undefined
): string | null {
  if (!ws) return null;
  const inferred = inferCommandWorkspaceType(command);
  if (!inferred) return null;
  if (compatibleWorkspaceTypes(ws.type, inferred)) return null;
  if (!LANGUAGE_TYPES.has(ws.type)) return null;
  return `This looks like a ${TYPE_LABEL[inferred]} command, but “${ws.name}” is a ${TYPE_LABEL[ws.type]} workspace — it will run in that folder and may not find its toolchain.`;
}
