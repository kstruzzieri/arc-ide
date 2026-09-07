# Issue #263: Golem Settings Phase 1 — Read-Only Configuration Projection

## Issue Summary

Firn had no way to show the user their effective Golem (go-llm) configuration
— which config file was selected, which roles route to which models, which
providers are reachable, and why a route is unusable — without exposing raw
filesystem paths, JSON, or credentials across the Wails boundary. Phase 1
adds a read-only settings surface: a pure Go projection builder that maps a
loaded (or failed) go-llm config onto a bounded, allowlisted DTO; a
process-wide snapshot the Service shares between `Settings`, `Status`, and
`StartTurn`; two zero-input Wails bindings; TypeScript boundary validators
that mirror the Go contract byte-for-byte; and a minimal frontend view reached
from the Golem panel and the command palette. Write paths (editing or
applying configuration) are explicitly out of scope — Phase 2.

## Acceptance Criteria

- [x] Config source discovery reports which branch matched (`env` |
      `working_directory` | `user_config` | `legacy` | `none`) without
      leaking the path itself across the boundary.
- [x] Malformed JSON is distinguished from other invalid-config causes without
      string-matching the raw error.
- [x] The projection builder maps every load outcome (missing / invalid /
      oversized / ready) onto one of four states with bounded, allowlisted
      diagnostics — never a raw go-llm error, path, or credential.
- [x] A shared fixture corpus is validated identically by the Go oracle and
      the TypeScript validators, so the two implementations cannot drift.
- [x] The service loads configuration once per process (or per reload) and
      shares that snapshot across `Settings`, `Status`, and `StartTurn`;
      loading a snapshot never itself authorizes a config source for a
      workspace.
- [x] `ReloadSettings` only runs when every conversation is idle, and a
      concurrent reload/read/close cannot observe a half-built snapshot.
- [x] `GetGolemSettings` / `ReloadGolemSettings` take no input, so nothing a
      caller supplies can influence discovery, and every error is one of the
      existing fixed public messages.
- [x] The frontend can only construct a `SettingsProjection` that passes the
      same closed-set/bounds validation as the Go oracle; a malformed payload
      throws the fixed `GolemContractError` rather than rendering garbage.
- [x] The configuration view is reachable from the Golem panel, from the
      unavailable state, and from the command palette, and restores focus
      correctly on every path.

## Red-Green Cycles by Area

### 1. Config source origin + JSON-syntax sentinel (`internal/ai/config.go`)

- Red: `TestDiscoverAgentConfigSourceReportsOrigin` asserted
  `discoverAgentConfigSource` returned a `sourceOrigin` value alongside the
  existing path/error — the function did not return one yet.
  `TestLoadDefaultAgentConfigClassifiesJSONSyntax` asserted a malformed
  `models.json` produced an error distinguishable from other invalid-config
  causes via `errors.As`/`errors.Is`, not a substring check.
- Green: added the closed `sourceOrigin` type (`none | env |
  working_directory | user_config | legacy`), had each discovery branch
  return its own origin, and added `errConfigJSONSyntax` — chained alongside
  `ErrAgentConfigInvalid` with `%w: %w` (Go 1.20+ multi-wrap) so
  `SanitizeError`'s existing switch is untouched and callers can test either
  sentinel independently.
- A later fixture-alignment commit (`cd61384`) caught that the config test
  fixtures shaped their `Providers`/`Models` maps differently from what
  production `config.Load` actually returns; the fixtures were corrected to
  match, not the reverse.

### 2. Projection builder + cross-language corpus (`internal/ai/settings.go`)

- Red: `TestBuildSettingsProjectionReady`, `...Failures`,
  `...NilConfigDegrades`, `...Limited`, `...LimitedKeepsAgentBlocking`,
  `...OverlongIdentifierLimited`, `...OverlongEndpointLimited`, and
  `...BoundEdges` were written against a `buildSettingsProjection` that did
  not exist yet (or, in later rounds, against bound/diagnostic behavior it
  did not yet implement).
- Green: `buildSettingsProjection(loaded, err)` — pure, no I/O — maps one
  load outcome to `missing | invalid | limited | ready`. `ready` walks
  `cfg.Defaults`/`Models`/`Providers` into sorted, deterministic slices;
  `limited` withholds the collections entirely but keeps at most one bounded
  blocking diagnostic for the agent route (`selectedAgentBlockingDiagnostic`)
  so a limited projection can never silently hide an unusable agent route.
  Diagnostic ordering is producer-enforced: the Go builder sorts
  blocking-first, then code, then subject name (`sortDiagnostics`, Go-tested);
  the TS side renders the received order and does not re-verify it.
  Every projected identifier is scrubbed on the way out
  (`sanitizeProjectionIdentifiers`): control and bidi-format runes (Unicode
  Cc/Cf) become U+FFFD so a hostile config key cannot visually spoof the
  configuration view. Identifier bounds are measured on the sanitized form
  (sanitize-then-bound), since the scrub can grow a 1-byte control to the
  3-byte replacement character.
- `TestSettingsProjectionSerializationLeaksNothing` locks the no-leak
  guarantee: marshal the projection and assert it never contains a
  filesystem separator, `.json`, or a fixture-planted API key.
- `TestSettingsContractCorpus` (`internal/ai/settings_test.go`) is the Go
  half of the cross-language corpus: it feeds every fixture in
  `internal/ai/testdata/settings_contract/` through `structuralCheck` (a
  hand-rolled JSON structural validator independent of `encoding/json`'s
  struct tags) and `validateSettingsProjection` (the semantic oracle:
  closed-set membership, bounds, forbidden identifier runes). Both validators
  reject unknown keys at every level: the Go corpus decode uses
  `DisallowUnknownFields`, and the TS readers enforce per-object key
  allowlists (`hasOnlyKeys`) — strict in both directions. That strictness is
  a deliberate same-repo-lockstep choice: producer and validators ship
  together, so an unknown key is contract drift, never forward
  compatibility. Companion frontend test
  `golem.settings.test.ts` `describe('cross-language contract corpus')`
  confirms the same directory exists and is non-empty from the TS side.
  External codex review hardened the oracle over three follow-up commits: a
  precise UTF-8-byte-count definition for every bound (`21f23ea`), nested
  structural presence checks so a fixture cannot omit a required nested key
  and still validate (`0768ddf`), and scalar-type/null checks plus the
  257-diagnostic worst-case cap (`fd44df2`).

### 3. Process-wide snapshot + per-binding source protection (`internal/ai/service.go`)

- Red: `TestSnapshotSharedAcrossConversations` asserted two conversations
  under the same binding observe the identical snapshot pointer/epoch
  without a second config load; `TestSettingsSnapshotProtectedPerBinding` and
  `TestServiceRepoLocalConfigSourceProtected*` asserted that loading a
  snapshot must not itself grant a workspace access to the config source —
  only the current binding's `ScopePolicy` can.
- Green: `loadedSnapshot` (projection, resolved target or error, load error,
  lexical/canonical path, epoch) is built once by `buildSnapshotLocked` and
  cached on `Service.snapshot`, guarded solely by `snapshotMu`.
  `resolveTargetLocked` — the one path `Status` and `StartTurn` share — calls
  `policy.ProtectConfigSource(sn.canonicalPath)` on **every** call, cache hit
  or not, because the policy is per binding incarnation while the snapshot
  lives across binding changes until the next reload. The lock order is
  fixed and documented on `Service`: `bindingGate -> conversation admission
  mutex -> snapshotMu`; `snapshotMu` is never held while acquiring another
  lock.

### 4. Idle-barrier reload, linearized against admission and close (`internal/ai/service.go`)

- Red: `TestSettingsReturnsProjection` (baseline), `TestReloadSettingsSwapsSnapshotWhenIdle`,
  `TestReloadSettingsRecoversFromMissingConfig`, `TestReloadSettingsBusyStates`,
  `TestReloadSettingsConsentBarrier`, `TestReloadClosesIdleRunnerUnderWriter`,
  `TestReloadSettingsBlocksAdmissionUntilSwap`, `TestSettingsReadBlocksDuringReload`,
  and `TestReloadSettingsVersusClose` drove `Settings()`/`ReloadSettings()`
  before they existed, then against race conditions between reload and
  concurrent admission/read/`Close`.
- Green: `Settings()` takes the `bindingGate` read side, rechecks `closing`
  under it, and returns `snapshotOrBuild().projection` — no per-binding
  source protection runs here, since no target is published and the
  projection carries no path or key. `ReloadSettings()` registers a
  lifecycle waitgroup unit (so `Close` waits out a mid-flight reload), then
  takes the `bindingGate` **write** side and requires every conversation to
  be exactly `stateIdle` (running and canceling both count as busy; expired
  consent challenges are dropped first) — otherwise it returns
  `{Busy: true}` with the unchanged current projection, never blocking. On
  an idle barrier, the rebuild is unconditional (a previously-latched load
  failure can only be recovered here), the snapshot is swapped, every
  conversation's idle runner is closed **while still holding the writer** so
  no admission can construct a replacement before its predecessor fully
  quiesces, and exactly one `golem:status-changed` event fires after
  release.

### 5. Wails bindings (`app.go`)

- Red: `TestGolemSettingsMethodsUninitializedService` asserted
  `GetGolemSettings`/`ReloadGolemSettings` return the fixed
  `"Golem is unavailable."` message (not a panic) before `App.aiService`
  exists. `TestGolemMethodSignaturesCarryStructsUnchanged`'s `zeroInput`
  cases asserted both methods take exactly zero arguments — nothing a caller
  supplies can influence discovery — and that their response types
  (`SettingsProjection`, `SettingsReloadResult`, and their nested
  `RouteProjection`/`ModelProjection`/`ProviderProjection`/`Diagnostic`
  types) carry no field name matching `path`, `root`, `dir`, `key`, or
  `token`.
- Green: `GetGolemSettings`/`ReloadGolemSettings` follow the existing
  four-method pattern exactly — nil-service guard, delegate to
  `a.aiService`, route every error through `a.golemError` (host-log the raw
  cause, return only the fixed `ai.PublicError` projection). A later commit
  (`786eef6`) moved the DTOs to settings.go (from service.go) and renamed the
  reload operation's log label for consistency with the other ops.

### 6. TypeScript boundary validators (`frontend/src/types/golem.ts`)

- Red: `golem.settings.test.ts` drove `parseSettingsProjection` and
  `parseSettingsReloadResult` against valid and invalid payloads before the
  functions existed: closed-set enums, UTF-8 byte-bounded strings, capped
  arrays, and the boundary between "accepted" and `GolemContractError`.
- Green: every enum (`SettingsState`, `SettingsSourceOrigin`,
  `ProviderClassification`, `CredentialState`, `DiagnosticSubjectKind`,
  `SettingsDiagnosticCode`, `CapabilityName`) is validated against a `const`
  allowlist mirroring the Go source exactly. String bounds are measured with
  `TextEncoder`-encoded byte length (`utf8Length`), never `String.length`,
  because UTF-16 code-unit counts disagree with Go's `len()` on non-ASCII
  input — the same input must cross or fail the same bound on both sides of
  the boundary. `readCappedArray` rejects any array over its bound before
  reading a single element, mirroring the Go builder's own
  `exceedsProjectionBounds`.

### 7. View, panel toggle, and command palette entry (frontend)

- Red: `GolemConfiguration.test.tsx` drove the component before it existed —
  reload-on-mount, a silent snapshot on a busy mount vs. an explicit-refresh
  busy notice, disabling Refresh while in flight, no state update after
  unmount, and focus moving to the heading on mount.
  `describe('golemView navigation')` in `golemStore.test.ts` drove the
  `golemView: 'chat' | 'configuration'` store flag (navigation-only — the
  store carries no configuration data itself).
  `describe('configuration view')` /
  `describe('configuration view and command palette focus interplay')` in
  `GolemPanel.test.tsx` drove the panel's `SettingsIcon` toggle, the "Review
  configuration" action reachable from the unavailable state, and focus
  restoration via a pending-ref/`useLayoutEffect` pattern after the palette
  closes. `commands.test.ts` drove the `golem-configuration` palette command
  opening the right panel on the configuration view.
- Green: `GolemConfiguration` is deliberately kept outside the Zustand store
  — component-local `useState` plus a generation-token ref so a stale
  in-flight response from an unmounted/reloaded instance is dropped rather
  than applied. It calls `ReloadGolemSettings` (not `GetGolemSettings`) on
  mount so the view always reflects the latest effective configuration; a
  busy reload on mount degrades silently to the current snapshot, while an
  explicit Refresh click surfaces the busy notice. `GolemPanel` adds a
  header `SettingsIcon` toggle and a "Review configuration" action from the
  unavailable state; both set `golemView` and restore focus to the previous
  control when the view closes. The palette command `golem-configuration`
  opens the right panel directly onto the configuration view.

## Contract Facts

| Fact | Value |
| --- | --- |
| Projection states | 4 — `missing`, `invalid`, `limited`, `ready` |
| Source origins | 5 — `none`, `env`, `working_directory`, `user_config`, `legacy` |
| Diagnostic codes (allowlist) | 7 — `config_missing`, `json_invalid`, `config_invalid`, `agent_role_missing`, `agent_capabilities_insufficient`, `provider_endpoint_unsupported`, `projection_limited` |
| Capability names (canonicalized) | 7 — `chat`, `generate`, `stream`, `embed`, `tool_call`, `thinking`, `insert` |
| Max collection entries (routes/models/providers) | 256 each |
| Max identifier length | 256 — **UTF-8 bytes**, not UTF-16 code units or runes |
| Max endpoint length | 1024 — UTF-8 bytes |
| Max diagnostics | 257 (256 + 1: one `provider_endpoint_unsupported` per provider, plus one agent diagnostic) |
| Cross-language fixture corpus | 18 fixtures in `internal/ai/testdata/settings_contract/` (8 `accept-*`, 10 `reject-*`), validated identically by the Go oracle (`settings_test.go`'s `validateSettingsProjection` + `structuralCheck` + `DisallowUnknownFields` decode) and the TS validators (`parseSettingsProjection` in `frontend/src/types/golem.ts`) |
| Unknown keys | Rejected at every level by BOTH validators (Go: `DisallowUnknownFields`; TS: `hasOnlyKeys`) — deliberate same-repo-lockstep strictness, not forward compatibility |
| Identifier rune policy | Builder scrubs all Cc/Cf runes to U+FFFD (`sanitizeIdentifier`); both oracles reject the explicit forbidden list (C0/C1 + bidi/format runes), kept byte-identical between `forbiddenIdentifierRunes` (Go) and `FORBIDDEN_IDENTIFIER_RUNES` (TS) |
| Fixed public error messages (unchanged by this work) | 8 — `SanitizeError`'s 7 sentinel cases plus the catch-all |

Exceeding a bound never redefines go-llm validity — the runtime agent target
still resolves normally — it only withholds the *projection* as `limited`.

## Accepted Risks and Reserved Seams

- **Unbounded config-file reads.** Phase 1 reads the config file without a
  size cap; a pathologically large `models.json` costs memory/CPU before the
  bounds checks can classify it `limited`. Accepted as a local
  resource-exhaustion risk until the Phase 2 document API's single-snapshot
  bounded parse lands (go-llm#410 criterion 1).
- **`GetGolemSettings` has no Phase 1 caller — by design.** The frontend view
  calls `ReloadGolemSettings` on mount. `GetGolemSettings` is the pure-read
  seam reserved for Phase 2 surfaces; it exists now so the read-without-reload
  binding is in place before Phase 2 starts, not as dead code to remove.
- **Identifier display policy.** The builder scrubs all Unicode Cc/Cf runes to
  U+FFFD; the validators reject the explicit forbidden list (C0/C1 controls
  plus the spoofing-relevant bidi/format runes). The builder is deliberately
  broader than the contract — producer stricter than contract is safe; the
  reverse would split corpus verdicts.

## Verification

All five gates run clean from this worktree (raw output redirected to files,
not proxied): `npm test`, `npm run lint`, `npm run build` (frontend);
`go test ./...`, `golangci-lint run ./...` (backend). See the Task 12 gate
run for exact tails.
