# Issue #43: Accessibility Improvements (WCAG AA)

## Issue Summary

Close the reproducible WCAG AA gaps remaining at baseline
`64dff74bd05795b71c3cf1b043cbb3f90d5e3803` without replacing accessibility
behavior that was already present. The work is limited to bypass navigation,
contrast, keyboard focus/navigation, and Terminal session-menu semantics.

## Audit Baseline and Scope

The audit confirmed that FileExplorer roving focus and Arrow/Home/End behavior,
file-tree `aria-busy`, existing live-status regions, and explicit production
button types were already shipped. Those paths were left unchanged and covered
by the full regression suite.

The remaining reproducible gaps were:

- no skip-to-main-content link;
- muted text, opacity-reduced muted consumers, run-profile tags across tinted
  card states, and CodeMirror comments on the active-line tint below 4.5:1;
- blue/general workspace focus accents below 3:1 on active editor tabs;
- every StructureView treeitem and several tablists in the page Tab order;
- missing Arrow/Home/End navigation in StructureView and the Editor, Terminal,
  and compound-output tablists;
- a pointer-only Terminal session menu without menu semantics or managed focus;
- BranchSwitcher dismissal paths that did not return focus to the trigger.

No dependency, backend API, generated binding, store refactor, FileExplorer
behavior, README, or roadmap change is part of this work.

## Standards Mapping

| Change | Standard behavior |
| --- | --- |
| Native skip link and focusable `main` target | [WCAG 2.2 — 2.4.1 Bypass Blocks](https://www.w3.org/WAI/WCAG22/Understanding/bypass-blocks) |
| Text, tag, and comment contrast | [WCAG 2.2 — 1.4.3 Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) |
| Focus-indicator contrast guard | [WCAG 2.2 — 1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) |
| Tree, tab, menu, and popup keyboard operation | [WCAG 2.2 — 2.1.1 Keyboard](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html) and [2.4.3 Focus Order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html) |
| StructureView roving focus | [ARIA APG Tree View Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/) |
| Editor, Terminal, and compound-output tablists | [ARIA APG Tabs Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) |
| Terminal session actions | [ARIA APG Menu Button Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/) |

## Test Strategy

- Add focused behavior tests before each production edit.
- Parse live CSS/palette literals and calculate WCAG relative luminance without
  rounding before the threshold comparison.
- Exercise every required Arrow/Home/End branch, manual tab activation, tree
  ownership relationship, and close-focus fallback.
- Use full `userEvent` pointer sequences for menu-overlay focus behavior rather
  than click-only events that omit browser focus defaults.
- Composite production opacity, hover/state tints, selected tree/card tints,
  and the CodeMirror active-line overlay in the numeric guards.
- Run the complete frontend, build, Go, diff, and packaged-Wails checks after
  task-level review fixes.

## TDD: Red Evidence

| Slice | Expected failing result before production changes |
| --- | --- |
| Shell and BranchSwitcher | 3 failed, 11 passed: missing skip target and missing trigger-focus restoration |
| StructureView | 5 failed, 10 passed: multiple tree tab stops, missing navigation, and stale active-node fallbacks |
| Shared contrast | 20 failed, 29 passed: six muted surfaces, six tag pairs plus exact alpha checks, preview-tag token, and comment threshold |
| Editor/Terminal/compound tabs and menu | 3 failed suites; 10 failed, 32 passed: missing roving tab focus, mixed Terminal tablists, and menu/focus behavior |

Task review added regressions before each follow-up fix:

- Terminal rename-input double-click reset the draft: 1 failed, 11 passed.
- A full pointer overlay click left focus on `body`: 1 failed, 11 passed.
- Rename Enter commit lost focus and input right-click opened the session menu:
  2 failed, 11 passed.
- The external-focus overlay path also blurred to `body`: 1 failed, 12 passed.

Each failure was observed before its corresponding production guard.

The first whole-diff deep review then exposed eight omitted cases. Test-only
patches reproduced all of them before production fixes:

- contrast/source matrices: 3 failed suites, 41 failed and 105 passed tests;
- selected workspace-tinted hidden names: 4 failed and 22 passed tests;
- generic Editor focus-ring coverage: 3 failed and 23 passed tests;
- StructureView parent/group ownership: 1 failed and 15 passed tests;
- named/Tab-dismissed Terminal menu plus Editor close focus: 2 failed suites,
  7 failed and 26 passed tests.

Fresh re-review then tightened two claims: the concrete Terminal Tab destination
failed 1/15 cases because forward Tab landed on `body`, and the nested Editor
close-button focus matrix failed blue/general plus its shared-token assertion
(3 failed, 32 passed). Both were red before their final fixes.

The final publication review found incomplete tab-to-panel ID references,
focusable close/rename controls nested inside `role="tab"`, and a Terminal close
button whose context menu leaked into the session menu. The test-only patch
failed 7/56 tests across three suites. After that structural fix, a final
Terminal pass exposed an unnamed rename textbox and inactive pointer padding;
its two regression tests failed while the other 18 passed. Every publication
finding was therefore observed red before its production fix. One final
path-with-spaces case then proved that raw editor file paths broke the panel's
ID reference (1 failed, 19 passed) before the shared safe-ID fix.

## Implementation

- `IDEShell` now starts with a native skip link whose focused presentation uses
  existing tokens and whose destination is `main#main-content[tabindex='-1']`.
- `--text-muted`, redundant consumer opacity, the two failing run-profile tag
  foregrounds, the preview-tag foreground, and all comments failing on the
  real active-line composite were corrected at their smallest shared sources.
- Editor tabs use a dedicated contrast-safe `--focus-ring` while retaining
  workspace accents for their semantic ownership styling; nested tab-close
  buttons use the same focus token.
- StructureView derives one visible tab stop, tracks the focused node, and uses
  mounted visible DOM order for Arrow Up/Down, Home/End, expand/child movement,
  collapse/parent movement, and stale-node fallback. Expanded parent items own
  their sibling child groups through stable `aria-owns` IDs.
- Editor, Terminal panel/session, and compound-output tablists use manual
  activation: focus moves and wraps without selecting until native or existing
  Enter/Space activation occurs.
- Their tabs and panels have stable, reciprocal ID references. Editor and
  Terminal session close/rename controls are siblings of the semantic tab
  targets rather than descendants hidden by tab presentational semantics.
  Editor file-path IDs are URI-encoded so whitespace cannot split an ARIA ID
  reference.
- Terminal exposes separate panel and session tablists. Its session actions use
  `menu`/`menuitem`, focus the first item, support Arrow Up/Down, Home/End, and
  Escape, carry a session-specific accessible name, close after native Tab or
  Shift+Tab focus movement, and restore focus after dismissal, rename, or close
  without overriding an external pointer-selected destination.
- If native Tab traversal cannot find a destination from the programmatically
  focused menuitem, Terminal resolves the next/previous document tab stop
  relative to the popup instead of allowing focus to fall to `body`.
- Descendant key, double-click, and context-menu events remain owned by Terminal
  rename/close controls. The full padded session-tab surface retains pointer
  activation, rename, and menu behavior while those nested controls suppress
  wrapper events. Rename textboxes have session-specific accessible names, and
  pointer-overlay tests include the browser's mousedown focus behavior.
- BranchSwitcher returns focus to its trigger after Escape and branch selection.
- Keyboard-closing a file or diff tab focuses the final selected tab, or the
  main-content landmark after the last tab closes.

## Numeric Contrast Evidence

### Muted text (`#90a0b6`)

| Surface | Ratio |
| --- | ---: |
| Base `#020617` | 7.578899 |
| Frame `#0b1120` | 7.074242 |
| Panel `#0f172a` | 6.707164 |
| Elevated `#152035` | 6.116495 |
| Hover `#1e293b` | 5.495982 |
| Active `#243147` | 4.914681 |
| Selected project tree tint (worst workspace tint) | 4.555268 |

The shared focus ring `#38bdf8` against active `#243147` is 6.106334:1,
above the 3:1 non-text threshold for every Editor workspace accent.

### Run-profile tags across real card states

| Tag | Base ratio | Worst state | Minimum ratio |
| --- | ---: | --- | ---: |
| Dev | 8.562653 | Project hover | 6.389359 |
| Test | 7.180267 | Project hover | 5.559342 |
| Build | 8.637600 | Amber hover | 6.534940 |
| Lint | 7.642587 | Project hover | 5.721612 |
| Deploy | 6.933509 | Amber hover | 5.393607 |
| Fallback | 7.372919 | Project hover | 5.561777 |

### CodeMirror comments on the active-line tint

| Palette | Ratio |
| --- | ---: |
| Glacier | 4.574878 |
| Solar | 4.590372 |
| Reef | 4.578771 |
| Nebula | 4.572972 |
| Bifrost | 4.596404 |
| Aurora | 4.578771 |
| Abyssal | 4.603087 |

## TDD: Green Evidence

| Focused suite | Result |
| --- | --- |
| IDEShell + BranchSwitcher | 2 suites, 14/14 tests passed |
| StructureView | 1 suite, 16/16 tests passed |
| All issue-focused shell/tree/contrast/tab/menu suites | 10 suites, 272/272 tests passed |
| Final tab-semantics remediation matrix | 4 suites, 92/92 tests passed |
| Terminal after whole-diff fixes | 1 suite, 20/20 tests passed |

Independent task reviews approved the shell/branch, StructureView, and contrast
slices without findings. The tabs/menu review found the pointer and rename-field
focus defects recorded above; every finding received a failing regression, a
scoped fix, and a final re-review verdict of Ready with no remaining finding.

The first deep whole-diff review returned `REQUEST_CHANGES` with eight Medium
findings and no Critical, High, or security finding. Those eight cases are the
additional red/green cycles recorded above. Fresh Pass 0–3 re-review reproduced
and cleared the follow-up focus risks. The publication review then reproduced
and cleared the final semantic, event-boundary, accessible-name, and ID-safety
findings; its independent component and test re-reviews returned `APPROVE`.

## Full Verification

Executed from the linked worktree after the clean whole-diff re-review:

```text
frontend: npm test -- --runInBand
134 suites passed; 1633 tests passed; 0 failed; 0 snapshots

frontend: npm run lint
exit 0; 0 errors; 12 pre-existing warnings

frontend: npm run format:check
exit 0; all matched files use Prettier style

frontend: npm run build
exit 0; TypeScript and Vite production build; 275 modules transformed

repository: go test ./...
660 tests passed in 12 packages

repository: wails build
exit 0; packaged darwin/arm64 Firn.app built successfully
```

The full Jest run still prints the known baseline React `act(...)` warnings in
FileExplorer, FileExplorer.reveal, RunProfileSelector, BranchSwitcher, and
tree-view store tests, plus the expected error-path console message in
`useOpenFolder.test.ts`. No new warning or console error was introduced by the
focused accessibility suites.

## Bounded Native and Assistive-Technology Evidence

- A standalone production preview returned HTTP 200, but—as expected for this
  Wails application—could not initialize `EventsOnMultiple` without the native
  host. It was not treated as product keyboard evidence.
- The current `Firn.app` packaged successfully and was launched through macOS.
  In this automation session, System Events exposed the `firn` process with
  `AXApplication` and `AXMenuBar` only, zero AX windows. With no application
  window available to the automation surface, an honest packaged Tab-order,
  200% zoom, accessibility-tree, or VoiceOver interaction pass could not be
  performed.
- Role/state, roving focus, full keyboard branches, full pointer focus defaults,
  and focus restoration are therefore evidenced by the focused DOM integration
  tests. A human run on a desktop where the packaged webview exposes its window
  is still required for VoiceOver/NVDA announcements and 200% visual inspection;
  none of those checks is claimed here.
