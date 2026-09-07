# Firn IDE Architecture

This document describes the system architecture of Firn IDE for contributors and maintainers.

## Component Overview

Firn IDE uses a hybrid architecture: a **Go backend** for system operations and a **React frontend** for the user interface, connected via the Wails framework.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Firn IDE Application                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                     React Frontend (Vite)                       │ │
│  │                                                                  │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │ │
│  │  │  Header  │  │ Sidebar  │  │  Editor  │  │ Terminal │       │ │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │ │
│  │        │             │             │             │              │ │
│  │        └─────────────┴──────┬──────┴─────────────┘              │ │
│  │                             │                                    │ │
│  │                    ┌────────▼────────┐                          │ │
│  │                    │  Zustand Store  │                          │ │
│  │                    │   (ideStore)    │                          │ │
│  │                    └────────┬────────┘                          │ │
│  └─────────────────────────────┼────────────────────────────────────┘ │
│                                │                                      │
│  ┌─────────────────────────────▼────────────────────────────────────┐ │
│  │                    Wails Runtime Bridge                          │ │
│  │              (JavaScript ↔ Go function calls)                    │ │
│  └─────────────────────────────┬────────────────────────────────────┘ │
│                                │                                      │
│  ┌─────────────────────────────▼────────────────────────────────────┐ │
│  │                       Go Backend                                 │ │
│  │                                                                  │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │ │
│  │  │     App      │  │  FileSystem  │  │ProcessManager│          │ │
│  │  │  (app.go)    │  │ (interfaces) │  │ (interfaces) │          │ │
│  │  └──────────────┘  └──────────────┘  └──────────────┘          │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Frontend Components

| Component | Location | Responsibility |
|-----------|----------|----------------|
| `IDEShell` | `components/layout/` | Main layout container with panels |
| `Header` | `components/Header/` | Logo, workspace/recent-project selector, search trigger |
| `Sidebar` | `components/Sidebar/` | Navigation icons (Explorer, Search, Git, Run) |
| `FileExplorer` | `components/FileExplorer/` | File tree navigation |
| `Editor` | `components/Editor/` | CodeMirror 6 code editor |
| `SearchPanel` | `components/Search/` | Workspace-wide ripgrep search UI |
| `Terminal` | `components/Terminal/` | Integrated terminal panel |
| `RunProfiles` | `components/RunProfiles/` | Build/run configurations |
| `RunOutput` | `components/RunOutput/` | Streaming run output views |
| `StatusBar` | `components/StatusBar/` | Git branch, cursor position, diagnostics |

### Backend Components

| Component | File | Responsibility |
|-----------|------|----------------|
| `App` | `app.go` | Main application struct, Wails lifecycle and bindings |
| `filesystem` | `internal/filesystem/` | Directory reads, file reads/writes, metadata, encodings |
| `watcher` | `internal/watcher/` | fsnotify-based file watching with debounce |
| `workspace` | `internal/workspace/` | Workspace state persistence and recent projects |
| `runprofile` | `internal/runprofile/` | Profile detection, persistence, execution, output streaming |
| `terminal` | `internal/terminal/` | PTY session management |
| `lsp` | `internal/lsp/` | LSP client, stdio transport, registry, URI handling |
| `search` | `internal/search/` | ripgrep runner, JSON parser, cancellation, typed results |
| `ai` | `internal/ai/` | Golem chat: repository binding/epochs, scope policy, Remote consent, run lifecycle |

## Data Flow

Data flows through the application in a unidirectional pattern:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   User      │     │   React     │     │   Wails     │     │     Go      │
│  Action     │────▶│  Component  │────▶│  Runtime    │────▶│   Backend   │
└─────────────┘     └──────┬──────┘     └─────────────┘     └──────┬──────┘
                          │                                        │
                          │                                        │
                   ┌──────▼──────┐                                │
                   │   Zustand   │◀────────────────────────────────┘
                   │    Store    │         (async response)
                   └──────┬──────┘
                          │
                   ┌──────▼──────┐
                   │  UI Update  │
                   │ (re-render) │
                   └─────────────┘
```

### Example: Opening a File

1. User clicks a file in `FileExplorer`
2. Component calls `useIDEStore().openFile(fileData)`
3. Zustand store updates `openFiles` and `activeFileId`
4. `Editor` component re-renders with new file
5. `ensureEditorFileOpen` reads file content from Go via Wails when needed

### Example: Workspace Search

1. User presses Cmd+Shift+F or opens the Search sidebar
2. `useWorkspaceSearch` debounces query/options from `searchStore`
3. React calls `SearchWorkspace` through Wails
4. Go runs `rg --json` with explicit arguments and cancellation
5. Parsed file/match results are stored in `searchStore`
6. `SearchPanel` renders grouped results and opens matches through the editor navigation flow

## State Management

Firn uses **Zustand** for state management. `ideStore` owns the main IDE/session state, while focused stores such as `lspStore` and `searchStore` own feature-specific state that should not live as derived counters or duplicated data in `ideStore`.

### Store Structure

```typescript
// frontend/src/stores/ideStore.ts

interface IDEState {
  // Workspace
  workspace: WorkspaceInfo | null;
  isLoadingTree: boolean;

  // Sidebar
  activeSidebarView: 'explorer' | 'search' | 'git' | 'run';

  // Editor
  openFiles: EditorFile[];
  activeFileId: string | null;
  cursorPosition: { line: number; column: number };

  // Terminal
  activeTerminalTab: 'terminal' | 'output' | 'problems';
  terminalSessions: TerminalSession[];

  // Run profiles
  runProfiles: RunProfile[];
  runOutputs: Record<string, RunOutputState>;

  // Status
  gitBranch: string;
}
```

Diagnostics live in `lspStore` as a full URI -> diagnostics map. The Problems panel and StatusBar share the conflict-aware `useProblemsProjection()` hook; severity totals are derived from that projection rather than separately maintained status fields.

### Selector Hooks

Use provided selector hooks to prevent unnecessary re-renders:

```typescript
// Good: Uses stable selector
const workspace = useWorkspace();
const activeFile = useActiveFile();

// Avoid: Creates new selector on each render
const workspace = useIDEStore(state => state.workspace);
```

### Available Selectors

| Hook | Returns |
|------|---------|
| `useWorkspace()` | Current workspace info |
| `useIsLoading()` | Loading state |
| `useSidebarView()` | Active sidebar view |
| `useOpenFiles()` | Array of open files |
| `useActiveFileId()` | ID of active file |
| `useActiveFile()` | Active file object |
| `useCursorPosition()` | Cursor line/column |
| `useTerminalTab()` | Active terminal tab |
| `useGitBranch()` | Current git branch |
| `useRunProfiles()` | Run profile list |
| `useProblemsProjection()` | Conflict-aware Problems groups and total count |

### Actions

```typescript
const store = useIDEStore();

// Workspace
store.setWorkspace(workspace);
store.setLoading(true);

// Sidebar
store.setSidebarView('explorer');

// Editor
store.openFile(file);
store.closeFile(fileId);
store.setActiveFile(fileId);
store.setCursorPosition({ line: 10, column: 5 });
store.setFileModified(fileId, true);

// Terminal
store.setTerminalTab('output');

// Status
store.setGitBranch('main');
```

For LSP diagnostics and workspace search state, use `lspStore` and `searchStore` actions rather than adding parallel counters or result state to `ideStore`.

## Run Profiles: Persistence and UI State

Run profiles live in per-workspace `.firn/` metadata owned by the `internal/runprofile` package. Saved profile definitions and adoption live in `.firn/run-profiles.json`; volatile run recency lives in `.firn/run-recency.json`.

### File Schema (v3)

The profiles file is versioned. **v3** adds an adoption-only `profileState` map keyed by profile ID, alongside the unchanged `profiles` array:

```jsonc
{
  "version": 3,
  "profiles": [ /* saved run profiles — unchanged from v2 */ ],
  "profileState": {
    "<profileId>": {
      "adopted": true  // working-set membership (user pulled a detected profile in)
    }
  }
}
```

`v2 → v3` migration is **additive**: a v2 file loads cleanly with an empty `profileState`, and the saved `profiles` are untouched. Older v3 files that embedded `lastRunAt` are migrated into `.firn/run-recency.json` on load.

Run recency is stored separately:

```jsonc
{
  "version": 1,
  "recency": {
    "<profileId>": 1700000000000
  }
}
```

### Snapshot Hydration Contract

`RunProfilesSnapshot{ profiles, profileState }` (defined in `internal/runprofile/project_manager.go`) is the single contract the frontend hydrates from. It is:

- Returned by `App.GetRunProfilesSnapshot()` for the initial load.
- Emitted on the `runprofiles:changed` Wails event after every state change — initial load, pin/unpin, variant change, adopt/unadopt, and a successful run.

The frontend re-validates the payload with `normalizeSnapshot` (`hooks/useRunProfiles.ts`) before storing it via `setRunProfilesSnapshot`, so `runProfiles` and `runProfileState` in `ideStore` always come from a validated snapshot rather than ad-hoc updates. Adopt/unadopt apply an optimistic local change first (`adoptProfileLocal`/`unadoptProfileLocal`) and revert it if the backend call rejects; the next snapshot reconciles the authoritative state.

### Section Model

The panel renders each profile in the **first** matching section (`utils/groupProfiles.ts`):

| Section | Membership |
|---------|------------|
| Activated (Working Set) | Detected profile that has been adopted |
| Pinned | Saved/user profiles |
| Recent | Detected, previously run, top 5 by `lastRunAt` |
| Detected | Everything else detected |

Run recency drives both the Recent ranking and the "just ran" indicator. For a compound profile, launching it records `lastRunAt` only for the launched profile — its child steps are not stamped.

## Adding New Features

Follow this guide when adding new functionality to Firn IDE.

### 1. Create the Go Backend (if needed)

Add methods to `app.go` that will be exposed to the frontend:

```go
// app.go

// ReadFile reads a file and returns its contents.
// Exposed to frontend via Wails binding.
func (a *App) ReadFile(path string) (string, error) {
    content, err := os.ReadFile(path)
    if err != nil {
        return "", err
    }
    return string(content), nil
}
```

### 2. Update Interfaces (for testability)

If the feature requires system calls, add to `interfaces.go`:

```go
// interfaces.go

type FileSystem interface {
    // ... existing methods ...

    // NewMethod does something new.
    NewMethod(param string) (Result, error)
}
```

### 3. Add Frontend State (if needed)

Extend the Zustand store in `frontend/src/stores/ideStore.ts`:

```typescript
interface IDEState {
  // ... existing state ...
  newFeatureData: NewFeatureType | null;
}

interface IDEActions {
  // ... existing actions ...
  setNewFeatureData: (data: NewFeatureType) => void;
}
```

### 4. Create React Component

Create a new component directory:

```
frontend/src/components/NewFeature/
├── NewFeature.tsx        # Component implementation
├── NewFeature.module.css # Scoped styles
└── index.ts              # Public export
```

### 5. Write Tests First (TDD)

Create failing tests before implementation:

```typescript
// frontend/src/__tests__/NewFeature.test.tsx

describe('NewFeature', () => {
  it('should render correctly', () => {
    // Test implementation
  });
});
```

```go
// newfeature_test.go

func TestNewFeature(t *testing.T) {
    // Test implementation
}
```

### 6. Document in TDD Directory

Create `docs/tdd/NNN-feature-name.md` with:
- Issue summary
- Acceptance criteria
- Test strategy
- Before/after test output

## Wails Bindings

Wails automatically exposes Go methods to the frontend JavaScript.

### How Bindings Work

1. Structs registered as an `application.Service` in `main.go`'s `Services` option have their public methods exposed
2. `wails3 generate bindings` emits TypeScript bindings (also run automatically by `wails3 task <os>:build`)
3. Generated bindings call the Wails v3 runtime (`$Call.ByID(...)`); application code imports them through `frontend/src/wails/bindings`

### Current Bindings

```go
// main.go
Services: []application.Service{
    application.NewService(app), // Exposes all public methods on *App
},
```

### Exposed Methods

| Go Method | Application Call | Returns |
|-----------|------------------|---------|
| `App.GetWorkspaceInfo(repoPath)` | `GetWorkspaceInfo(repoPath)` | `Promise<WorkspaceInfo>` |
| `App.GetGolemStatus(req)` | `GetGolemStatus(req)` | `Promise<ai.Status>` |
| `App.RunGolemTurn(req)` | `RunGolemTurn(req)` | `Promise<ai.TurnAdmission>` |
| `App.CancelGolemRun(identity)` | `CancelGolemRun(identity)` | `Promise<boolean>` |
| `App.GetGolemSettings()` | `GetGolemSettings()` | `Promise<ai.SettingsProjection>` |
| `App.ReloadGolemSettings()` | `ReloadGolemSettings()` | `Promise<ai.SettingsReloadResult>` |

The Golem surface is deliberately narrow. `GetWorkspaceInfo` is the only call
that takes a path: it binds the repository, returns the canonical root the
backend authorized plus its `repoKey`/`repoEpoch`, and unbinds when given `""`.
The other three carry `internal/ai` structs unchanged and address work by
identity alone — no path, no provider endpoint — so a frontend caller cannot
redirect the repository root or the destination. Every error they return is a
fixed public message; the raw cause is logged host-side only. Run output
arrives asynchronously on the `golem:event`, `golem:run-status`, and
`golem:status-changed` events.

`GetGolemSettings` and `ReloadGolemSettings` are a separate, deliberately
scoped read-only surface: both take no input, so nothing a caller supplies can
influence configuration discovery. The returned `SettingsProjection` carries
only an allowlisted set of diagnostic codes paired with safe subject names
(a role, model, or provider identifier) — never the raw go-llm error text.
Configuration source paths (the discovered `models.json` location) never
cross this boundary either, matching the run-path's own protection; the fixed
eight-message error seal that `SanitizeError` applies to run-path failures is
unchanged by this addition. `ReloadGolemSettings` rebuilds the effective
snapshot only under an idle barrier — every conversation must be fully idle,
or the call reports `busy: true` with the unchanged current projection — so a
reload can never observe or interrupt an in-flight run.

### Adding New Bindings

1. Add a public method to `App` (or create a new struct):

```go
// app.go

// SaveFile saves content to a file path.
func (a *App) SaveFile(path string, content string) error {
    return os.WriteFile(path, []byte(content), 0644)
}
```

2. Rebuild the application (`wails3 task build` or `wails3 task dev`)

3. Wails generates bindings in `frontend/bindings/firn/`:

```typescript
// Auto-generated
export function SaveFile(path: string, content: string): Promise<void>;
```

4. Import and use in React through the adapters. Only
   `frontend/src/wails/bindings.ts` and `frontend/src/wails/runtime.ts` may
   import generated `bindings/` paths, enforced by `no-direct-wailsjs.test.ts`:

```typescript
import { SaveFile } from '../wails/bindings';

async function handleSave() {
    await SaveFile('/path/to/file', editorContent);
}
```

### Binding Conventions

- **Method names**: PascalCase (Go convention)
- **Return values**: Automatically converted to JavaScript equivalents
- **Errors**: Returned as rejected promises
- **Structs**: Returned as generated class instances (`createFrom`), not plain objects.
  `frontend/tsconfig.json` sets `useDefineForClassFields`, so every declared optional field is
  an own property valued `undefined` on every instance, whether or not the wire carried it — a
  presence check at a boundary must therefore mean "own key holding a defined value"
  (`hasPresentKey` in `frontend/src/types/golem.ts`), not a bare `Object.hasOwn`.
- **Golem contract calls**: the nine object-returning Golem bindings are the one exception —
  the adapter reads them raw through the runtime's `Call.ByID` so the wire-contract validators
  in `frontend/src/types/golem.ts` and `golemConfig.ts` see the untouched payload instead of a
  class instance that has already defaulted missing fields and emptied null collections. The
  header comment on `GOLEM_RAW_CALL_IDS` in `frontend/src/wails/bindings.ts` is the primary
  record; `frontend/src/__tests__/wails/golemRawCalls.test.ts` pins the ids to the generated
  bindings and fails when a new object-returning binding is not routed raw — it keys on the
  generated return type (`$CancellablePromise<ai$0.…`), plus any Golem-named binding, so a
  future object-returning call in this area escapes the guard neither by being renamed nor by
  never having carried "Golem" in its name.

### Type Mapping

| Go Type | TypeScript Type |
|---------|-----------------|
| `string` | `string` |
| `int`, `int64` | `number` |
| `bool` | `boolean` |
| `[]byte` | `string` (base64) |
| `struct` | generated `class` |
| `error` | `Promise rejection` |

## Project Structure

```
firn-ide/
├── main.go                 # Application entry point
├── app.go                  # App struct and business logic
├── interfaces.go           # Testable interfaces
├── *_test.go              # Go tests
├── frontend/
│   ├── src/
│   │   ├── App.tsx        # Root React component
│   │   ├── main.tsx       # React entry point
│   │   ├── components/    # React components
│   │   ├── stores/        # Zustand stores
│   │   ├── styles/        # Global CSS (tokens, reset)
│   │   ├── utils/         # Utility functions
│   │   ├── __tests__/     # Jest tests
│   │   └── wails/         # Adapter — single import surface for generated bindings
│   ├── bindings/          # Auto-generated Wails bindings
│   └── package.json
├── build/                  # Build config, Taskfiles, platform assets (packaged output goes to root bin/)
├── docs/
│   ├── architecture.md    # This file
│   └── tdd/               # TDD documentation per issue
└── .github/workflows/     # CI/CD configuration
```
