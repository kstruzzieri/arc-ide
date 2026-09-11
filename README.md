<p align="center">
  <img src="docs/screenshots/firn-ide.png" alt="Firn IDE - Light Core, Deep Focus" width="800">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-in%20development-blue" alt="Status">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" alt="Platform">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Go-1.25+-00ADD8?logo=go&logoColor=white" alt="Go">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React">
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Wails-3-DF0000?logo=wails&logoColor=white" alt="Wails">
</p>

---

## Why Firn?

Modern monorepos contain frontend (React/TypeScript), backend services (Python, Go), and infrastructure code. Traditional IDEs either:

- **Load everything at once** — consuming 4-8GB+ RAM with all language servers running
- **Require separate windows** — losing context when switching between frontend and backend

**Firn takes a different approach:** One repo, multiple focused workspaces.

Each workspace has independent layout state, scoped language servers (only the active workspace runs LSP), and workspace-specific Run Profiles. Switching workspaces is instant—like changing perspectives, not opening a new app.

## Install

**Quick install** (macOS and Linux) — downloads the latest release and installs it:

```bash
curl -fsSL https://raw.githubusercontent.com/kstruzzieri/firn-ide/v0.12.0/install.sh | sh
```

Put the assignment on the `sh` side of the pipe so the script actually receives it — pin a version with `FIRN_VERSION`, or preview without installing with `FIRN_DRY_RUN`:

```bash
# preview the resolved download URL and target dir without installing
curl -fsSL https://raw.githubusercontent.com/kstruzzieri/firn-ide/v0.12.0/install.sh | FIRN_DRY_RUN=1 sh

# pin a specific release instead of the latest
curl -fsSL https://raw.githubusercontent.com/kstruzzieri/firn-ide/v0.12.0/install.sh | FIRN_VERSION=v0.12.0 sh
```

Windows users: use the manual zip below.

Prefer to do it by hand? Download the latest build for your platform from the [Releases page](https://github.com/kstruzzieri/firn-ide/releases/latest).

> **Preview builds are unsigned**, so macOS and Windows warn on first launch. The per-platform steps below get you past it.

### macOS (12 Monterey or later)

1. Download `Firn-macos-arm64.zip` (Apple Silicon) or `Firn-macos-amd64.zip` (Intel).
2. Unzip and move `Firn.app` to `/Applications`.
3. First launch is blocked by Gatekeeper. Either right-click `Firn.app` → **Open** → **Open**, or clear the quarantine flag:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Firn.app
   ```

### Linux (x86_64)

1. Download `Firn-linux-amd64.tar.gz`.
2. Extract and run:

   ```bash
   tar -xzf Firn-linux-amd64.tar.gz
   chmod +x firn
   ./firn
   ```

3. Requires WebKit2GTK 4.1 — e.g. on Debian/Ubuntu: `sudo apt install libwebkit2gtk-4.1-0`.

### Windows 10/11 (x64)

1. Download `Firn-windows-amd64.zip` and extract `firn.exe`.
2. First launch may show a SmartScreen warning → **More info** → **Run anyway**.
3. Requires the [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on Windows 11; auto-installed or downloadable on Windows 10).

Prefer to build from source? See [Development](#development).

## Key Design Decisions

### Wails over Electron

Firn uses [Wails](https://wails.io) (Go backend + system WebView) instead of Electron:

| Aspect | Electron | Wails |
|--------|----------|-------|
| Binary size | ~150MB+ | ~15MB |
| RAM baseline | ~300MB+ | ~50-100MB |
| Startup | 2-5 seconds | <1 second |
| Bundled runtime | Chromium + Node.js | System WebView |

The trade-off: Fewer npm packages that rely on Node.js APIs work out-of-the-box. Worth it for a lightweight, fast IDE.

### Golem, the built-in assistant

Firn ships an assistant rather than integrating an external one. Golem runs on
the embedded [`go-llm`](https://github.com/kstruzzieri/go-llm) runtime in the Go
process — there is no CLI shell-out and no separate service — and it is scoped
to the bound repository with a sensitive-path floor.

Remote egress is consent-gated per destination and durable: nothing leaves the
machine until a destination is approved, and the approval is recorded so it is
not asked again. Providers, models, roles and destinations are configured from
the Golem configuration workspace inside the app, and the same runtime writes
commit messages.

Still ahead: durable multi-conversation history (#264), token and context usage
once `go-llm` emits it (#265), and a guarded preview-and-apply mode for
mutating edits (#261).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Wails Runtime                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐              ┌─────────────────────────┐   │
│  │   Go Backend    │◄────────────►│    React Frontend       │   │
│  │                 │   bindings   │                         │   │
│  │  • File System  │              │  • CodeMirror 6 Editor  │   │
│  │  • FS Watcher   │              │  • Zustand State        │   │
│  │  • Run Profiles │              │  • Run Profile Cards    │   │
│  │  • Run History  │              │  • Run Output Views     │   │
│  │  • PTY Terminal │              │  • Panel System         │   │
│  │  • Workspace    │              │  • LSP Editor UX        │   │
│  │  • Git          │              │  • Git + Merge Views    │   │
│  │  • LSP Client   │              │  • Search UI            │   │
│  │  • ripgrep      │              │  • Golem Chat + Config  │   │
│  │  • Golem/go-llm │              │                         │   │
│  └─────────────────┘              └─────────────────────────┘   │
│                                          ▲                      │
│                                          │ window relay         │
│                                          ▼                      │
│                              ┌─────────────────────────┐        │
│                              │  Undocked Golem Window  │        │
│                              │  (passive view; the     │        │
│                              │   main window executes) │        │
│                              └─────────────────────────┘        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

| Component | Technology |
|-----------|------------|
| Backend | Go 1.25+ (layered package structure) |
| Frontend | React 19 + Vite + TypeScript |
| State | Zustand |
| Editor | CodeMirror 6 |
| File Watching | fsnotify with debounce |
| Language Intelligence | LSP per active workspace |
| Search | ripgrep workspace search + CodeMirror in-file search |
| Golem chat | Center island in the main window, or a second native window |

### The Golem chat window

The Golem chat lives in the center of the main window beside the Files column,
and can be undocked into a second native window: **Undock into a window** on the
GOLEM command bar, or `Golem: Undock into a Window` in the command palette. It
comes back with **Dock in main window** on that window's title bar, `Cmd/Ctrl+W`
there, or **Dock Golem panel** on the Golem rail the main window shows while the
chat is away. Both windows render the same chat surface, but only the main
window ever executes: it owns the conversation store and the `go-llm` runtime,
and the undocked window is a passive view that posts actions across the window
relay and waits for the main window to admit or refuse each one. During a
handoff neither window accepts input, and composer text is carried over with the
transfer rather than re-derived.

Whether the chat is docked, and where the undocked window last sat, are the only
machine-scoped preferences Firn keeps: they live in `~/.firn/app.json` as a mode
and a bounds rectangle. No transcript, draft or consent decision is written
there — those stay with the repository-scoped Golem state.

### Performance Targets

- **Cold start:** < 2 seconds
- **Idle CPU:** near 0% (event-driven, no polling)
- **Core RAM:** ~200-450MB (without language servers)
- **Workspace switch:** Instant (0ms perceived delay)

## Current Implementation

### Completed

**Backend (Go)**
- [x] Layered package structure (domain, application, infrastructure, interfaces)
- [x] `ReadDirectory` — recursive directory listing with file metadata
- [x] `ReadFile` — content reading with automatic encoding detection (UTF-8, UTF-16, Latin-1)
- [x] `WriteFile` — content writing with encoding preservation
- [x] File system watcher — real-time external change detection with debounced events
- [x] Workspace store — open folder, persistence, recent projects
- [x] LSP client foundation — JSON-RPC framing, stdio transport, lifecycle, crash recovery, diagnostics/status events
- [x] Search backend — ripgrep JSON parsing, cancellation, typed errors, and result caps

**Run Profiles (Go + React)**
- [x] Auto-detection from package.json, go.mod, Makefile, pyproject.toml, docker-compose
- [x] Process executor with lifecycle management (start, stop, restart, SIGTERM grace period)
- [x] Real-time output streaming with line assembly and FIFO truncation
- [x] Pin/unpin profiles (promote detected to saved, demote back)
- [x] Run history tracking (last 50 runs per profile with pass/fail/duration)
- [x] Waveform activity visualization (output rate per 500ms interval)
- [x] Status badges (RUNNING, PASSED, FAILED, READY, STOPPING, STOPPED)
- [x] Auto-expand cards for active states, auto-collapse on completion
- [x] Purpose-built expanded panels per state (activity graph, output preview, stats, error detail, SIGTERM progress)
- [x] Predicted completion ETA with median-based estimation and running card sort
- [x] Failed-state attention pulse animation
- [x] Reactive re-detection on config file changes via file watcher
- [x] Workspace-owned detection and identity — each profile owns a workspace, with workspace-scoped IDs and a per-workspace `.firn/run-profiles.json`
- [x] Four-section working set (Working Set / Pinned / Recent / Detected) with per-workspace adoption and Workspace/Project views
- [x] Header profile selector with a single `Cmd+R` run target, shared with the panel
- [x] Create / edit / customize / delete profile form (Start-from picker, inline env vars, working-dir folder picker, env variants)
- [x] Hidden-profile section to unhide, and header **+** to create a profile

**Frontend (React/TypeScript)**
- [x] CodeMirror 6 editor with Firn Glacier theme
- [x] Syntax highlighting (JS, TS, Python, Go, CSS, HTML, JSON, Markdown)
- [x] Tab-based editing with modified indicators
- [x] JetBrains-style autosave (debounced idle + focus loss)
- [x] Per-file undo/redo history preserved across tab switches
- [x] File explorer with tree navigation — virtualized rows with lazy per-directory loading on expand
- [x] Hybrid workspace tree rails — active-scope and per-file ownership shown as two distinct rails in Workspace view
- [x] Unreadable directories stay visible, labeled, and retryable in place
- [x] Workspace accent color system (7 theme variants)
- [x] Command palette (`Cmd/Ctrl+Shift+P`) over a shared late-bound command registry with deterministic fuzzy matching
- [x] Panel layout system with drag-to-resize and collapse/expand
- [x] Icon system with currentColor SVGs
- [x] Status bar (cursor position, language, git branch)
- [x] Toast notification system

**Language Intelligence**
- [x] Frontend document sync (`didOpen`, debounced `didChange`, `didSave`, `didClose`)
- [x] TypeScript/JavaScript LSP vertical slice through `typescript-language-server --stdio`
- [x] Diagnostics underlines, gutter markers, Problems panel, and status-bar counts
- [x] Completion source with trigger characters, detail/docs, and snippet support
- [x] Hover tooltips and go-to-definition (`F12`, Cmd/Ctrl-click)
- [x] Current-file Structure view built from document symbols
- [x] Shared registry entries for Go (`gopls`) and Python (`pyright-langserver`)
- [x] Managed server provisioning — pinned `basedpyright`, `gopls`, `typescript-language-server`, and `rust-analyzer` installed under `~/.firn`, with interpreter wiring and offline/retry setup guidance (active workspace only; never mutates global env/PATH)

**Search**
- [x] Workspace-wide ripgrep search with regex, case, and whole-word options
- [x] Results grouped by file with highlighted matches and keyboard navigation
- [x] Match-anchored result rows with file/directory hierarchy that stays readable in a narrow panel
- [x] Dimmed syntax-token highlighting in match context, so the match itself stays the brightest element
- [x] Cmd+Shift+F opens workspace search
- [x] Click result to open the file at the match location
- [x] In-file find/replace through CodeMirror search (`Cmd+F`)

**Terminal Integration**
- [x] PTY backend — shell sessions with bidirectional I/O and ANSI support
- [x] xterm.js frontend — themed terminal with Firn Glacier colors
- [x] Multiple terminal sessions — create, switch, close, rename, drag-to-reorder
- [x] Graceful process termination — SIGHUP via PTY close with SIGKILL fallback
- [x] Shell integration — OSC 133 command separators and exit-status error markers (zsh/bash)

**Run Output Panel**
- [x] Per-profile output display with tab selection
- [x] Multiple view modes (merged, lanes, diff, timeline)
- [x] Independent per-stream lane scrolling (stdout/stderr) with a resizable split
- [x] Auto-scroll with toggle
- [x] Output folding for repeated patterns
- [x] Compound run profiles — sequential multi-step execution with per-step output and aggregate status
- [x] First-class run execution identity — output, lifecycle, and status routed by execution-instance id
- [x] Retained run history — same-profile parallel runs plus persisted terminal ordinary/compound summaries and lazy ordinary output from `internal/runhistory`
- [x] Bounded history retention — 50 summaries and 5 rich ordinary records per profile, 10 MiB per record, and a 20 MiB workspace target
- [x] Explicit durability boundary — terminal events enqueue history; close drains appends for up to 300 ms, waits for explicit redactions, and still withholds acknowledgement when editor flush fails
- [x] Owned compound execution plans (#146 Phase 2D) — an `executionNode` tree deep-copied at admission, with a recursive reflection guard against self-referencing plans

**Version Control (Git)**
- [x] Working-tree status in the file tree (modified/added/deleted/untracked colors) and current branch in the status bar
- [x] Branch switcher shared between an always-visible header pill and the status bar
- [x] Diff viewer — side-by-side, next/prev change navigation, resizable columns, and an editable working-tree side for unstaged changes
- [x] Commit panel — per-file and section include checkboxes, stage/commit, pull/push (Publish when there is no upstream), workspace-scoped
- [x] Gutter change bars with a peek popup — unified word-level inline diff and one-click revert-to-HEAD
- [x] Hunk-level stage/unstage from editor and diff gutters, including intent-to-add support for untracked files
- [x] Merge conflict resolution editor — Current / Incoming / Both / Manual decisions on a live Result spine, with a conflict rail, keyboard navigation, undo-safe region mapping, and no write or stage until every region is resolved
- [x] Merge confidence layer — hover and focus preview of the exact lines a choice produces, word-level marks between the two sides, provenance stripes showing where each resolution landed, exact targeted reopen of any decision, the common ancestor per region or as a lazy stage-`:1` strip, line numbers with per-card line ranges, and polite screen-reader announcements

**AI (Golem)**
- [x] Workspace chat panel (#226 phase 1) — read-only assistant on the embedded `go-llm` runtime, scoped to the bound repository with a sensitive-path floor, consent-gated remote egress with durable per-destination approval, streamed conversations that survive workspace switches, and a persistent status-bar segment (`Cmd/Ctrl+Shift+I`)
- [x] Git commit messages on the embedded `go-llm` runtime (#165) — the CLI shell-out is gone
- [x] Configuration workspace (#263 slices A and B) — models, roles, profiles and provider destinations as a complete projection with typed diagnostics, applied through transactional writes that never leave settings half-written, with project keys write-only so a stored secret never reads back
- [x] Phase routing and destination admission from `go-llm` (#285) — consent-derived destination policy, capability floors for chat and commit-message routing, reachable-set admission mirroring upstream, and batch settings-apply consent with provenance, so a fallback destination cannot silently widen the granted scope
- [x] Center panel and undocked window (#271) — a full-height center island beside the Files column with persisted per-repository order, width and collapse, command bars for both panels, drag/keyboard/palette reorder, and an optional second native window that shares the surface while the main window stays the only executing owner

If the Golem consent store becomes unavailable — a banner appears, and remote egress is blocked — remove or hand-repair `~/.firn/golem-consent.json`, restart Firn, then re-consent through the chat panel, the settings surface, or the configuration workspace's `Check destinations…` action to write a fresh record. The store is opened only at startup, so refreshing configuration or approving again cannot recover it until Firn restarts with the repaired or removed file.

### Planned

- [ ] Git merge follow-ups — auto-merged region hints (#220), key-hold preview (#219), multi-file conflict rail (#221), bulk take-Current/Incoming (#223), pre-stage diagnostics check (#240), base-relative word marks (#241)
- [ ] Git — richer branch/VCS menu (#166)
- [ ] Context menus (#45) and breadcrumb navigation (#46)
- [ ] Golem — configuration slices C and D (#263, gated on upstream `go-llm`), durable multi-conversation history (#264), token and context usage (#265), guarded preview-and-apply mode (#261)
- [ ] Linux — GTK4 and WebKitGTK 6.0 (#281), required before Wails v3.1, which drops the GTK3 path this release targets

## Project Structure

```
firn-ide/
├── main.go                     # Application entry
├── app.go                      # Wails bindings
├── internal/
│   ├── ai/                     # Golem service, settings, consent, go-llm runtime
│   ├── appstate/               # Machine-scoped app state (~/.firn/app.json)
│   ├── filesystem/             # File read/write/watch
│   ├── git/                    # Status, diff, hunk staging, merge conflict data
│   ├── lsp/                    # LSP client, registry, transports, managed provisioning
│   ├── runprofile/             # Run profile detection, execution, management
│   ├── runhistory/             # Bounded persisted terminal run history
│   ├── search/                 # ripgrep search runner and parser
│   ├── terminal/               # PTY session management
│   ├── watcher/                # FS event watcher
│   ├── workspace/              # Workspace persistence
│   └── process/                # Process management
├── frontend/
│   ├── src/
│   │   ├── components/         # React components
│   │   │   ├── CommandPalette/ # Command palette over the shared registry
│   │   │   ├── Editor/         # CodeMirror 6 editor + merge resolution view
│   │   │   ├── FileExplorer/   # File tree navigation
│   │   │   ├── GitPanel/       # Commit/stage panel and diff surfaces
│   │   │   ├── Golem/          # Golem chat panel and center island
│   │   │   ├── GolemConfig/    # Golem configuration workspace
│   │   │   ├── GolemWindow/    # Undocked Golem window shell
│   │   │   ├── RunProfiles/    # Run profile cards and panels
│   │   │   ├── RunOutput/      # Output display (merged, lanes, diff, timeline)
│   │   │   ├── Search/         # Workspace-wide search
│   │   │   ├── Structure/      # Current-file symbol outline
│   │   │   ├── Terminal/       # xterm.js terminal
│   │   │   └── layout/         # Panel system, sidebar, header
│   │   ├── stores/             # Zustand state (ide, git, lsp, search, golem)
│   │   ├── hooks/              # Custom React hooks
│   │   ├── utils/              # Shared utilities
│   │   ├── types/              # TypeScript type definitions
│   │   └── wails/              # Adapter — single import surface for generated bindings
│   └── bindings/               # Generated Go bindings
└── docs/
    ├── roadmap.md              # Consolidated roadmap with all issues
    ├── design-specification.md # Full UI/UX specification
    └── architecture.md         # System architecture guide
```

## Development

### Prerequisites

- Go 1.25+
- Node.js 18+
- Wails CLI: `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.16` (on Linux, install `libgtk-3-dev` and `libwebkit2gtk-4.1-dev` first, then add `-tags gtk3` to that install command, matching CI)
- Linux only: `libgtk-3-dev` and `libwebkit2gtk-4.1-dev` (the Linux build compiles with the `gtk3` tag against WebKit2GTK 4.1)

### Commands

```bash
# Live development with hot reload
wails3 task dev

# Production build for the host platform -> bin/
wails3 task build

# Run frontend tests
cd frontend && npm test

# Run Go tests
go test -tags gtk3 ./...
```

See [build/README.md](build/README.md) for the per-platform tasks (`darwin:build`, `darwin:package`, `linux:build`, `windows:build`) and build-asset regeneration.

### Generated Wails Bindings

`frontend/bindings/**` is generated by `wails3`. The frontend no longer imports it directly — every import routes through the `frontend/src/wails/` adapter, enforced by a guard test (`frontend/src/__tests__/wails/no-direct-wailsjs.test.ts`) — but the generated output stays tracked as the checked-in input that adapter wraps. `wails3 task <os>:build` is the portable way to regenerate them (it passes each platform's `BUILD_FLAGS`, including Linux's `-tags gtk3` — the generator's package load resolves the GTK4 path without it). To regenerate by hand on macOS or Windows:

```bash
wails3 generate bindings -ts -time-type=string -clean=true -d frontend/bindings
```

On Linux, add `-f '-tags gtk3'` to that command or the generator loads the wrong package. `-clean=true` removes bindings for Go methods that no longer exist. Any `wails3 task <os>:build` regenerates bindings first (`-clean=true`), so a routine build keeps them current. The generated output is canonical and is never run through Prettier (`frontend/bindings` is excluded via `.prettierignore` and sits outside lint-staged's `frontend/src/**` glob). Commit changes only when a Go-facing API or exported model shape changes.

## Design Documentation

The [Design Specification](docs/design-specification.md) contains the complete UI/UX blueprint:

- Visual identity and theme tokens
- Workspace model and multi-workspace editing
- Run Profiles system
- AI Chat Panel design
- Keyboard shortcuts

See the [Roadmap](docs/roadmap.md) for implementation progress and all tracked issues.

## Current Priorities

`v0.12.0` is live. The Wails v3 host migration (#273), the Golem configuration workspace and its center panel with undocking (#263 slices A and B, #271), phase routing and destination admission from `go-llm` (#285), the embedded commit-message runtime (#165), the merge-resolution editor through phase 4 (#164, closed), run execution identity phase 2 (#146, closed), and the Go 1.25 toolchain upgrade (#225) have all shipped since v0.11.0.

Active tracks:

1. **Golem:** the configuration UI epic (#263) stays open for the write phases still gated on upstream `go-llm`. Next are durable multi-conversation history (#264) and token/context usage (#265), which waits on `go-llm` emitting usage; guarded preview mode (#261) follows. Readability and contrast follow-ups (#291, #293), the route-editor close affordance (#284), and the panel/undock follow-ups (#289) are queued behind them.
2. **Platform:** Linux must move to GTK4 and WebKitGTK 6.0 (#281) before Wails v3.1 can be adopted, since v3.1 drops the GTK3 path this release still targets. Migration hygiene follow-ups are tracked in #282.
3. **Git merge:** #164 is closed; the remaining backlog is auto-merged region hints (#220), key-hold preview (#219), the multi-file conflict rail (#221), bulk take-Current/Incoming (#223), and the phase 3 diagnostics follow-ups (#240, #241). Destructive VCS operations (#166) come after.
4. **Command UX:** context menus (#45) and breadcrumbs (#46), both reusing the #44 command registry.

Watcher and ignore-rule caching (#148/#196) stay benchmark-gated. Store extraction (#41) happens only when one of the tracks above needs it, not as a standalone rewrite.

## Contributing

This project follows a ticket-based workflow:

1. Issues tracked via GitHub Issues
2. Feature branches created from `develop`
3. Test-driven development required
4. PRs merged to `develop` after review
5. `main` reserved for releases

## License

MIT
