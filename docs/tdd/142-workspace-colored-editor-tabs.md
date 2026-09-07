# Issue #142: Workspace-Colored Editor Tabs

## Issue Summary

Color each open file and Git diff tab with the accent of the workspace that owns its path, independently of the active workspace. Ownership must reuse the segment-safe, longest-prefix workspace-region logic.

## Acceptance Criteria

- [x] File and diff tabs use their owning workspace accent.
- [x] Root and nested workspaces resolve correctly; the longest segment-safe match wins.
- [x] Paths outside all workspaces retain the neutral tab presentation.
- [x] Selected, hover, dirty, close, focus, keyboard, and ARIA behavior is preserved.
- [x] No active-workspace tab filtering or new palette values are introduced.

## Test Strategy

- Unit-test the shared path resolver for root ownership, nested ownership, unrelated paths, and path-segment boundaries.
- Render tabs from several workspaces while a different workspace is active and assert each tab's CSS accent token.
- Render a Git diff tab whose file belongs to a non-active workspace.
- Run the complete Jest suite, ESLint, Prettier, and the production frontend build.

## TDD: Before

The initial focused run failed because the shared resolver and per-tab accent did not exist:

```text
FAIL src/__tests__/utils/workspaceRegions.test.ts
  TypeError: createWorkspacePathResolver is not a function

FAIL src/__tests__/Editor.diff.test.tsx
  Expected: --tab-accent: var(--accent-blue)
```

The review regression test then exposed the missing Git diff-tab behavior:

```text
FAIL src/__tests__/Editor.diff.test.tsx
  Expected: --tab-accent: var(--accent-green)
```

## TDD: After

```text
PASS src/__tests__/Editor.diff.test.tsx
PASS src/__tests__/utils/workspaceRegions.test.ts

Test Suites: 2 passed, 2 total
Tests:       30 passed, 30 total
```

## Review Round 2: Accent Token Validation

Code review found the tab accent interpolated `WorkspaceDef.accent` into
`var(--accent-*)` unvalidated, unlike the existing `VALID_ACCENTS` guard in
WorkspaceTabs, WorkspaceSelector, and RunProfiles. A stale or hand-edited
persisted accent would produce an undefined custom property and silently break
the `color-mix()` styling. The regression test failed first:

```text
FAIL src/__tests__/Editor.diff.test.tsx
  Expected: --tab-accent: var(--accent-project)
  Received: --tab-accent: var(--accent-magenta)
```

Fix: shared `utils/accent.ts` (`accentVar`) with the neutral `project`
fallback, wired through a single `tabAccentStyle` helper for both tab kinds.

```text
PASS src/__tests__/Editor.diff.test.tsx
Tests: 31 passed (full suite: 1445 passed)
```
