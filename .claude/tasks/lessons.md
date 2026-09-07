# Firn IDE - Lessons Learned

## Phase 1: LSP Foundation (2026-03-28)

### 1. Self-introduced bug from fix cycle: stopping flag set before shutdownServer

**What happened:** During code review, a reviewer flagged a DidClose/ShutdownAll race. The fix set `entry.stopping = true` inside DidClose before calling `shutdownServer`. But `shutdownServer` treats `stopping == true` as "another goroutine is already handling this" and returns early. Result: the server was never actually shut down when the last document closed.

**Why it was missed:** The fix was tested only by verifying compilation and race-detector pass, not by writing a test that exercises the zero-doc teardown path end-to-end. The existing tests bypassed `Manager.DidClose` by directly manipulating `entry.openDocs`, so the regression was invisible.

**Lesson:** When fixing a race condition, write a test for the exact scenario BEFORE applying the fix. Don't rely on existing tests that bypass the layer you're fixing. Flag ownership semantics matter — if a function checks a flag to decide whether to act, the caller must not set that flag before calling it.

### 2. openDocs used as version map instead of reference counter

**What happened:** `openDocs` was typed as `map[string]int` where the int was the document version. The plan called it "reference counting" but the implementation stored versions, not counts. Opening the same file in two panes collapsed into one map entry. The first DidClose deleted it, potentially shutting down the server while the second pane was still active.

**Why it was missed:** The plan said "Track open documents per workspace/language with version numbers" which conflated two concerns: tracking which documents are open (ref counting) and tracking what version each document is at (for stale response filtering). The implementation followed the plan's wording literally without separating the two concerns.

**Lesson:** When the spec says "track documents with versions," separate the concerns: ref counting (how many consumers have this document open) is distinct from version tracking (what version of the content has been sent to the server). A single map field can't serve both purposes. Design the data structure around the operations that will use it (open/close for ref counting, didChange for version, diagnostics filtering for version comparison).

### 3. Tests bypassed the layer under test

**What happened:** Manager integration tests manually constructed `entry.openDocs[uri] = 1` and called `entry.client.DidClose(uri)` directly, instead of going through `Manager.DidOpen()` and `Manager.DidClose()`. This meant the reference counting, version tracking, and zero-doc shutdown logic in the Manager layer was never exercised by any test.

**Why it was missed:** The initial test setup used `startServer` directly (bypassing `ensureServer`) because the mock server needed special env vars. This made it natural to also bypass `DidOpen`/`DidClose` and manipulate the internals directly. Each shortcut felt small, but they cascaded into a test suite that validated the Client layer while leaving the Manager layer untested.

**Lesson:** Tests should exercise the public API of the layer under test. If test setup constraints force you to bypass an API (e.g., using `startServer` directly), still call the public methods for the operations you're testing. Extract test helpers (like `startMockManager`) that handle setup complexity without leaking it into test assertions.

### 4. Stale diagnostics forwarded without version filtering

**What happened:** The client advertised `publishDiagnostics.versionSupport: true`, telling the server to include version numbers in diagnostics. But `handleNotification` forwarded every diagnostics notification unchanged without comparing the diagnostics version against the tracked document version. Stale diagnostics would overwrite current ones in the frontend.

**Why it was missed:** Phase 1 focused on "can diagnostics be received and routed" without considering the temporal ordering problem. The version tracking was implemented in `openDocs` for `didChange` but was never wired to the notification handler. The two concerns (document sync and notification handling) were implemented independently without connecting them.

**Lesson:** When advertising a capability (versionSupport), implement the corresponding filtering in the same pass. Capabilities create contracts — if you tell the server you support versioned diagnostics, the backend must honor versions.

### 5. LSP workspace update coupled to run-profile success

**What happened:** `LoadRunProfiles` called `SetLSPWorkspaceRoot` only after `loadRunProfilesLocked` succeeded. If profile loading failed during a workspace switch, the LSP manager stayed pointed at the old workspace, routing all subsequent LSP requests to the wrong project context.

**Why it was missed:** The LSP workspace sync was added late (during code review) and was inserted at the end of `LoadRunProfiles` after the profile loading, following the existing code flow. The error-early-return at line 288 was already present, so the LSP sync was unreachable on failure.

**Lesson:** When coupling two subsystems (profiles and LSP) to a shared workspace state change, ask: "which of these MUST succeed for the other to proceed?" The LSP workspace root should always follow the user's workspace switch intent, regardless of whether profile detection succeeds. Independent subsystems should not gate each other's state transitions.

### 6. types.go bloated with dead constants and write-only struct trees

**What happened:** `types.go` defined all 25 `CompletionItemKind` constants, both `InsertTextFormat` constants, and 8 nested `ClientCapabilities` structs. None of the constants were referenced in production code — the backend passes them through as integers. The 8 capabilities structs existed solely to construct one static JSON object in `Initialize()` that never changes at runtime.

**Why it was missed:** The implementation followed a "define Firn's subset of LSP types" approach and defaulted to completeness — defining every enum value in a type felt like "the right thing to do" for a protocol implementation. The distinction between "types the backend needs to read/write" (struct fields) and "constants the frontend needs to interpret" (enum values for icon mapping) wasn't recognized during design. Similarly, the capabilities blob was modeled as typed Go structs because "everything should be typed" — without asking whether Go code ever reads those types back.

**Lesson:** Ask "who consumes this?" for every type and constant. If the Go backend just passes an integer through to the frontend as JSON, don't define 25 named constants in Go — the frontend will define its own TypeScript enums. If a value is write-once and never read back by Go code, a `json.RawMessage` literal is simpler and more honest than a type tree. Define types for what you deserialize and inspect, not for what you just marshal and forward.

### 7. Two parallel maps in registry with identical keys

**What happened:** `registry.go` had `extensionToLanguageID` and `extensionToFamily` as separate `map[string]string` variables with identical key sets. Adding a new extension required updating both maps — a maintenance hazard where they could drift.

**Why it was missed:** The two lookups (`LanguageIDForExtension` and `FamilyForExtension`) were implemented as separate methods, and the natural Go pattern was one map per method. The shared key set wasn't recognized as a code smell during implementation.

**Lesson:** When two maps share identical keys, merge them into one map with a struct value. One map, one lookup, no drift risk.

## Post-Phase 1 Review (2026-03-29)

Issues surfaced by external code review (Codex) that were missed during implementation and self-review.

### 8. Stray `type` token left in filereader.go broke Go compilation

**What happened:** An uncommitted bare `type` keyword at line 28 of `internal/filesystem/filereader.go` made `go build` and `go test ./...` fail. The worktree was in a non-compilable state.

**Why it was missed:** The token was introduced during an edit session that removed or refactored a type definition but left a fragment behind. The working tree was never re-validated with `go build` after the edit — the cached test results from before the edit masked the break. CI wasn't run against the local working tree, only against clean HEAD.

**Lesson:** After any edit to a Go file, run `go build ./...` before considering the change complete. Don't trust cached test results — they reflect the state at time of caching, not the current working tree. A "test passes" result from cache is not the same as "code compiles now."

### 9. Frontend never subscribed to lsp:reconnect after server crash recovery

**What happened:** The backend's crash recovery goroutine emits `lsp:reconnect` with the list of documents the restarted server needs. But the frontend's `useLSPDocumentSync` hook never subscribed to any Wails runtime events — it only tracked local `openedPaths` state. After a server restart, the new server had no document state, yet later `didChange`/`didSave` calls bypassed the `openedPaths` guard (the paths were still marked as "opened") and operated on an unopened document.

**Why it was missed:** The backend and frontend were implemented as separate work items. The backend crash recovery was fully implemented and tested in Go (including the `lsp:reconnect` event emission and verification). The frontend hook was built to handle the "normal" document lifecycle — open, change, save, close — without considering server-side restarts. The implicit assumption was "the server is always there once started." There was no test or checklist item that validated the full round-trip: backend crashes → emits event → frontend receives → re-opens documents.

**Lesson:** When two layers communicate via events, the subscription must be implemented and tested as part of the same work item as the emission. An event without a consumer is dead code. Add an integration checklist: "for each event the backend emits, where does the frontend subscribe? Is there a test that fires the event and asserts the frontend reacts?"

### 10. Closing a dirty file dropped unsaved edits (autosave race + LSP flush)

**What happened:** Two independent bugs conspired:
1. **Autosave race:** `closeFile()` in the store removed the file from `openFiles` immediately. The autosave hook's `saveFile()` looked up the file by ID in `openFiles` — but the file was already gone. The pending debounce timer fired into the void.
2. **LSP flush:** `sendDidClose` cancelled pending debounced `didChange` timers instead of flushing them. The last buffer state was never sent to the LSP server before the document was closed.

**Why it was missed:** The autosave and LSP document sync hooks were implemented independently, each watching the Zustand store for state changes. Neither hook considered what happens when the store mutation (removing the file) happens *before* their cleanup logic runs. The subscription pattern `useIDEStore.subscribe((state, prevState) => ...)` provides both states, but the autosave hook only used `state` (which no longer has the file), not `prevState` (which still does). For the LSP hook, `sendDidClose` tried to look up the file content from `openFiles` for flushing, but the store had already removed it.

The test suite tested "close cancels pending didChange" as the *desired* behavior, not a bug — the test asserted `expect(mockDidChange).not.toHaveBeenCalled()` after close. This enshrined the data-loss path as correct.

**Lesson:** When a store mutation removes an entity, any hook that needs to clean up based on that entity's data must capture the data *before* or *during* the mutation — not after. The Zustand subscription provides `prevState` for exactly this purpose. For the autosave hook, watch for files leaving `openFiles` in `prevState` and save them using the captured previous data. For LSP, pass the last known content as a parameter to the close handler rather than looking it up from the (already-mutated) store. Tests should validate the *invariant* ("no data loss on close"), not the *mechanism* ("cancel pending timers").

### 11. useFileWatcher hook existed but had no callers

**What happened:** `useFileWatcher` was fully implemented with proper event subscription and cleanup, but was never called from any component. The `file:changed` event path and reactive run-profile reload existed only on paper.

**Why it was missed:** The hook was created as part of a "file system infrastructure" pass, with the assumption it would be wired up during a later "integration" pass. That integration pass never happened — subsequent work moved on to LSP and run profiles. The hook wasn't in any checklist or test suite, so its unused state was invisible.

**Lesson:** A hook without a call site is dead code. Wire up the consumer in the same PR that creates the hook, even if the consumer is minimal. If the integration genuinely can't happen yet, add a failing test or TODO that blocks the PR from being considered complete.

## Milestone 6: Search (2026-05-04)

### 12. Parallel-worktree work committed directly to local develop instead of a feature branch

**What happened:** After PR #85 merged, two parallel worktree agents implemented Task 1 (backend ripgrep) and Task 4 (CodeMirror in-file find/replace). Their commits were cherry-picked into local `develop` along with a baseline cleanup commit and a tracker update — four commits in total — without ever creating a feature branch or opening a PR. This diverged silently from the M5 convention, which used a separate feature branch and PR for each phase (PR #77, #79, #81, #83, #85). The user caught this only when asking "are we working in feature branches?" after the work was already integrated.

**Why it was missed:** The session opened with `git status` showing branch `develop` clean at PR #85's merge. That state was treated as "the working branch" rather than "the integration target." When the cleanup commit landed on `develop` directly, no pause occurred to ask "what branch should this land on?" — and the subsequent cherry-picks followed the same path by inertia. The worktree dispatches used `isolation: "worktree"` which felt like sufficient isolation, but a worktree only isolates the *working tree*; the eventual integration commits still land on whatever branch the orchestrator is on. There was no project-level guardrail (pre-commit hook, CLAUDE.md note, or memory entry) codifying the feature-branch convention, so the M5 pattern existed only in the git history.

**Lesson:** Create the feature branch as the FIRST step of any multi-commit task — before the first commit, edit, or agent dispatch. The right opening sequence on a clean `develop`:

```bash
git checkout -b codex/milestone-N-<short-name> origin/develop
# OR
git checkout -b feature/<scope>-<short-name> origin/develop
```

For recovery when commits already exist on the wrong long-lived branch (no force-push, no cherry-pick churn):

```bash
git branch -m develop codex/<descriptive-name>     # rename current branch
git checkout -b develop origin/develop              # recreate develop tracking origin
git push -u origin codex/<descriptive-name>         # push feature
gh pr create                                         # open PR
```

Three habits that would catch this earlier:
1. First message after seeing a clean `develop` tree should be: "are we creating a feature branch, or extending an existing one?" Make the branch decision explicit, not implicit.
2. A pre-commit hook that warns or refuses commits to `develop`/`main` would have stopped commit #1 dead. Worth adding as a project-level guardrail.
3. The convention belongs in `CLAUDE.md` or persistent memory so future sessions default to it without asking. Workflow norms that live only in git history get re-broken.

This applies even to "small" work (like the cleanup commit) — once the first commit lands on the wrong branch, every subsequent commit compounds the problem and the recovery cost grows linearly.

**Bootstrap caveat for the repo-local pre-commit hook:** `.husky/pre-commit` only protects `develop` after the commit that adds the protection has actually reached `develop`. While the protection PR is open, `develop`'s working tree still has the old (unprotected) hook, so commits to `develop` continue to succeed silently. Verified: switching to `develop` and running `git commit --allow-empty` succeeded with the message "hook was ignored because it's not set as executable" until the protection PR merged. The robust counterpart to a repo-local hook is **GitHub branch protection rules** on the server side, which apply regardless of what's in any local working tree. Repo-local hooks complement but do not replace server-side protection.

## Issue #44 Design Review (2026-07-17)

### 13. Re-check moving baselines, complete shortcut ownership, and runtime APIs

**What happened:** The first Command Palette checkpoint used the handoff baseline after `develop` had advanced, omitted row shortcut chips, did not specify key-event containment, and accepted native-dialog testability without retaining the executable jsdom probe as a design constraint.

**Lesson:** Before implementation, compare the feature branch to current `develop`, search every displayed and handled shortcut owner, trace bubbling into global listeners, and execute a capability probe in the actual test runtime. Keep production on the native platform API when supported, but isolate any missing jsdom behavior in a test-only shim.

## Issue #263 Slice B (2026-08-27)

### 14. Regenerating Wails bindings reformatted 4.5k lines of `models.ts`

**What happened:** `wails generate module` rewrote `frontend/wailsjs/go/models.ts` in the
generator's own style. The committed baseline is Prettier-formatted, so the regen showed up
as a ~4,500-line reformat sitting on top of the handful of real new types — unreviewable, and
guaranteed to recur on the next regen.

**Lesson — the convention to follow every time bindings are regenerated:**

```bash
wails generate module                                   # regenerate
cd frontend && ./node_modules/.bin/prettier --write \
  --ignore-path /dev/null wailsjs/go/models.ts          # ONLY models.ts
```

Four rules, each load-bearing:

1. **Only `models.ts`.** `App.d.ts` and `App.js` stay exactly as the generator emits them;
   their committed baseline is raw generator output, so formatting them starts the same
   churn in two more files.
2. **`--ignore-path /dev/null`.** `frontend/.prettierignore` excludes `wailsjs/`, so without
   this flag Prettier silently no-ops and the reformat lands in the diff anyway.
3. **Run it from `frontend/`, never the repo root.** A root-level Prettier invocation picks up
   a different config resolution and reformats files outside `wailsjs/`.
4. **Modes stay `0644`.** The generator sometimes emits `0755`; `git diff` shows that as a
   mode change on an otherwise-untouched file.

The general shape: when a generator's output is committed in a *post-processed* form, the
post-processing step is part of the generation procedure, not a cleanup someone remembers.
Write it down next to the generate command or it gets re-litigated as a review finding.
