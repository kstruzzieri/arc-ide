/**
 * The single source of truth for the workspace accent set.
 *
 * The type, the runtime lookup and every test matrix are all derived from this
 * one tuple. Declaring them separately does not fail loudly: `Set<WorkspaceAccent>`
 * type-checks its *members* but not its *completeness*, so an accent added to the
 * union but missed here would silently fall through accentVar() to the neutral
 * "project" accent, with no compiler or test error.
 *
 * Order is presentation-neutral; nothing should depend on it.
 */
export const WORKSPACE_ACCENTS = [
  'project',
  'frontend',
  'go',
  'python',
  'docker',
  'node',
  'terraform',
  'rust',
  'general',
] as const;

export type WorkspaceAccent = (typeof WORKSPACE_ACCENTS)[number];

const VALID_ACCENTS: ReadonlySet<string> = new Set<WorkspaceAccent>(WORKSPACE_ACCENTS);

// accentVar maps an accent value to its CSS custom property, falling back to
// the neutral "project" accent for any value without a defined token. Accepts
// undefined because Run Profiles resolve an accent from an optional workspace.
export function accentVar(accent: string | undefined): string {
  return `var(--accent-${accent && VALID_ACCENTS.has(accent) ? accent : 'project'})`;
}
