# Issue #195: Unreadable Directories

## Issue Summary

Keep unreadable filesystem entries visible in the file tree, distinguish them
from empty directories, and let a later successful lazy read clear the warning
without replacing unrelated tree content.

## Acceptance Criteria

- [x] Recursive child read failures retain and mark the failed directory while
      readable siblings and descendants remain intact.
- [x] A visible `DirEntry` whose metadata read fails remains present and marked.
- [x] Lazy child failures mark the existing non-root node without inventing
      children or blanking the tree.
- [x] A successful direct retry clears the marker and installs real children.
- [x] Root failures remain explicit errors because no parent row exists.
- [x] The warning is visual, accessible, keyboard-retryable, virtualized, and
      independent from selection, workspace/file accents, and Git state.
- [x] Workspace changes and stale requests cannot annotate the wrong tree.
- [x] The generated Wails model carries the optional field; readable JSON omits it.

## Test Strategy

- Inject exact `ReadDir` and `Stat` failures through the existing filesystem mock.
- Keep one OS-level `chmod 000` permission smoke, with an explicit skip when the
  current platform or account can still read the directory.
- Exercise the existing lazy-loader, structural-sharing, watcher-reconcile,
  workspace-presentation, and root-fetch suites.
- Render the real virtualized tree row and assert its accessible name, retry
  affordance, keyboard active descendant, warning contrast, Git badge, and accent
  markers.

## TDD: Before

The backend RED cycle exposed each information-loss point independently:

```text
FileEntry.Unreadable missing: new contract tests did not compile
TestReadDirectory_HandlesPermissionError: restricted child had unreadable=false
TestReadDirectory_StatFailureKeepsEntryUnreadable: visible entry disappeared
TestReadDirectory_StatFailureDoesNotDescend: reader descended after Stat failed
TestFileEntryJSON_OmitsFalseAndCarriesTrueUnreadable: readable JSON carried false
TestReadDirectory_PermissionSmoke: restricted directory was represented as empty
```

The frontend RED cycle then proved that the shallow binding rejection needed a
separate state transition at the already-known requested path:

```text
useEnsurePathLoaded: rejected node unreadable was undefined
useEnsurePathLoaded: loaded-empty unreadable node was skipped instead of retried
useDirectoryTree: cached root rejection preserved content but surfaced no toast
TreeRow: accessible name remained "src" and no warning affordance rendered
Workspace View: unreadable scoped root became "No files in workspace"
useFileTreePresentation: rootUnreadable was undefined
```

The review/fix cycle added these RED cases before final verification:

```text
useDirectoryTree: uncached root error exposed an absolute path
useDirectoryTree: closing the workspace did not invalidate a pending root rejection
useDirectoryTree: cached-empty failure rendered a false empty state
useDirectoryTree: unmounted and same-path reopened workspaces accepted stale root results
useEnsurePathLoaded: A -> B -> A reused and accepted the original A request
useFileTreePresentation: a missing nested scope ignored its unreadable ancestor
useFileTreePresentation: retained stale children bypassed an unreadable ancestor
FileExplorer reveal: descendant probes continued after an ancestor failed
Workspace hydration: descendant probes continued after failure or a same-path reopen
filesystem permission test: hard-coded Unix paths were not portable to Windows
```

## Implementation Decision

`ReadDirectoryShallow` still returns only the requested directory's immediate
children and still rejects when that directory cannot be read. It was not widened
with an error wrapper. The frontend already knows the exact requested path, so it
marks that existing non-root node through one spine-sharing update. Recursive
reads set the same optional backend marker in-band. A direct successful merge
clears the marker; parent-only refreshes conservatively preserve it because they
do not prove the directory contents became readable.

## TDD: After

Focused backend verification:

```text
$ rtk proxy env GOCACHE=/private/tmp/firn-195-go-cache go test ./internal/filesystem/... -count=1
ok  firn/internal/filesystem  0.200s
```

The OS permission fixture passed on the development macOS account. On platforms
or accounts where mode `000` does not deny `ReadDir`, the test skips with that
specific reason while the injected failures remain the primary coverage.

Focused frontend verification:

```text
PASS App.reconcile.test.tsx
PASS FileExplorer.lazy.test.tsx
PASS FileExplorer.reveal.test.tsx
PASS FileExplorerVirtualization.test.tsx
PASS TreeRow.test.tsx
PASS useDirectoryTree.test.tsx
PASS FileExplorerViews.test.tsx
PASS useEnsurePathLoaded.test.ts
PASS useFileTreePresentation.test.tsx
PASS tokens.test.ts
PASS preserveLoadedChildren.test.ts
PASS replaceChildrenAt.test.ts
PASS wailsModels.test.ts

Test Suites: 13 passed, 13 total
Tests:       134 passed, 134 total
```

## Generated Binding

`rtk wails generate module` added only `unreadable?: boolean` and its constructor
assignment to `frontend/wailsjs/go/models.ts`. Generated file modes were restored
to `0644`; no binding signature or unrelated model changed.

## Full Verification

```text
$ rtk go test ./internal/filesystem/... -count=1
Go test: 50 passed in 1 packages

$ rtk go test ./... -count=1
Go test: 666 passed in 12 packages

$ rtk go vet ./...
Go vet: No issues found

$ rtk npm test -- --runInBand
Test Suites: 136 passed, 136 total
Tests:       1746 passed, 1746 total

$ rtk npm run lint
0 errors (12 pre-existing warnings)

$ rtk npm run format:check
All matched files use Prettier code style!

$ rtk npm run build
277 modules transformed; production build and language-bundle check passed

$ rtk git diff --check
(no output)

$ rtk git diff --summary frontend/wailsjs
frontend/wailsjs/go/models.ts | 2 ++
```

## Wails Smoke

`rtk wails build` produced the final packaged macOS binary successfully. It
was launched with an isolated `HOME` against a fresh disposable Git repository
at `/private/tmp/firn-195-final-smoke-20260716`:

- `frontend/locked` was mode `000`; expanding it kept `backend`, `readable`,
  and `package.json` visible and changed the row name to `locked, unreadable`.
- The earlier interactive failure pass captured the toast `Failed to load
  locked`; neither it nor the tooltip `Unable to read this item` exposed the
  absolute path or raw OS error. The loader regression test asserts the same
  generic toast on the final tree.
- The row remained `tabindex="-1"` with the tree as the only tab stop.
  Arrow navigation left the tree focused and the mounted unreadable row active;
  the decorative icon was `aria-hidden="true"`.
- Selecting with Space left the unreadable row active and `aria-selected=true`.
  Readable siblings, including `Dockerfile` and modified `tracked.ts`, remained
  mounted; focused tests cover their independent accent marker and Git badge.
- After `chmod 700`, the warning remained until a direct collapse/re-expand
  retry with Enter. That retry preserved selection, cleared the accessible
  unreadable title, and displayed `secret.txt`.
- The warning rendered with `--status-warning`; the automated token tests
  verify at least 3:1 contrast on panel, hover, active, and selected workspace
  tints.
- The packaged process emitted no stdout/stderr during the smoke. A targeted
  macOS log query for console errors, uncaught exceptions, unhandled rejections,
  `TypeError`, and `ReferenceError` returned no matches.
