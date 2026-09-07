# Issue #204: Loading Skeleton Suppressed for Uncached Workspace Fetch

## Issue Summary

During an uncached workspace's initial `ReadDirectoryShallow`, `fetchTree()`
called `setTreeLoading(true)` and then `setTreeError(null)`. The store's
`setTreeError` action also writes `isLoadingTree: false`, so the same
synchronous React batch cancelled the loading flag. The FileExplorer skeleton
gate never painted from this fetch path, and the empty `directoryTree`
rendered a false "No files in workspace" state while the read was in flight.
Pre-existing bug on develop, found during PR #203 review.

## Acceptance Criteria

- [x] Uncached workspace with a pending root read keeps `isLoadingTree` true
      until the read settles.
- [x] A resolved read ends the loading state with no error.
- [x] A rejected read ends the loading state and sets
      `treeError: 'Failed to read directory'`.
- [x] A cached-empty workspace refresh never surfaces `isLoadingTree`
      (existing test stays green); its failures still use the uncached error
      strategy (treeError, no toast).
- [x] Cached non-empty refresh behavior unchanged (toast + markDirty on
      failure, no skeleton).

## Test Strategy

- Extend `useDirectoryTree.test.tsx` with two RED-first tests driving a
  pending `ReadDirectoryShallow` promise: assert `isLoadingTree === true`
  while pending, then `false` after resolve; a reject variant asserts
  `treeError` set and loading ended.
- Confirm RED before touching code: both tests failed at the
  `isLoadingTree === true` assertion (received `false`).
- Keep the full existing suite green, notably "does not flash the loading
  skeleton for a cached-empty workspace".

## Implementation Notes

Minimal reorder plus one derived flag in `useDirectoryTree.ts` `fetchTree()`:

- `setTreeError(null)` now runs before `setTreeLoading(true)`, so the error
  action's `isLoadingTree: false` write cannot cancel the skeleton in the
  same batch.
- The plain reorder alone regressed the cached-empty test: the loading gate
  used `hasCachedTree = Boolean(cachedTree?.length)`, which treats a
  cached-empty tree (`[]`) as uncached. That test had only passed by riding
  the original bug. Added `hasCachedEntry = cachedTree !== undefined` to gate
  the skeleton on cache existence, while `hasCachedTree` still selects the
  error strategy (cached-empty failures surface `treeError`, cached-non-empty
  failures toast and mark dirty).
- Review pass aligned the `finally` gate to the same flag: the skeleton is
  now lowered on `!hasCachedEntry`, matching the raise gate, so only the
  request that raised the skeleton lowers it. A companion assertion in the
  cached-non-empty refresh test locks this in — a wrongly-raised skeleton
  there would persist past settle.
- `setDirectoryTree` intentionally still writes `isLoadingTree: false`; the
  cached-restore path in `useWorkspacePersistence.ts` depends on it and was
  not changed.

## Verification

- `npx jest --silent`: 136 suites, 1752 tests, 0 failures.
- `npm run lint`: 0 errors, 12 pre-existing warnings.
- `npm run format:check`: clean.
- `npx tsc --noEmit`: clean.

All outputs captured raw (redirected to files), not RTK-filtered.
