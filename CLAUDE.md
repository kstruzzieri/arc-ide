# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Firn IDE is a lightweight, workspace-focused IDE for macOS, Linux, and Windows built with Wails (Go + React/Vite).

**Architecture**: Wails framework using system webview for a lightweight binary (~15MB), avoiding Electron bloat.

## Project Structure

```
firn-ide/
├── main.go                     # Application entry point
├── app.go                      # Wails bindings
├── internal/
│   ├── filesystem/             # File read/write/watch
│   ├── git/                    # Status, diff, hunk staging, merge conflict data
│   ├── lsp/                    # LSP client, registry, managed provisioning, python env
│   ├── runprofile/             # Run profile detection, execution, management
│   ├── search/                 # ripgrep search runner and parser
│   ├── terminal/               # PTY session management
│   ├── watcher/                # FS event watcher
│   ├── workspace/              # Workspace persistence
│   └── process/                # Process management
├── frontend/
│   ├── src/
│   │   ├── components/         # React components
│   │   │   ├── CommandPalette/ # Cmd+Shift+P palette over the command registry
│   │   │   ├── Editor/         # CodeMirror 6 editor + merge resolution view
│   │   │   ├── FileExplorer/   # File tree navigation
│   │   │   ├── GitPanel/       # Commit/stage panel and diff surfaces
│   │   │   ├── RunProfiles/    # Run profile cards and panels
│   │   │   ├── RunOutput/      # Output display (merged, lanes, diff, timeline)
│   │   │   ├── Search/         # Workspace-wide ripgrep search UI
│   │   │   ├── Structure/      # Current-file symbol outline
│   │   │   ├── Terminal/       # xterm.js terminal
│   │   │   └── layout/         # Panel system, sidebar, header
│   │   ├── stores/             # Zustand state (ide, git, lsp, search)
│   │   ├── hooks/              # Custom React hooks
│   │   ├── utils/              # Shared utilities
│   │   ├── types/              # TypeScript type definitions
│   │   └── wails/              # Adapter — single import surface for generated bindings
│   └── bindings/               # Generated Go bindings
├── docs/
│   ├── roadmap.md              # Consolidated roadmap with all issues
│   ├── design-specification.md # Full UI/UX specification
│   └── architecture.md         # System architecture guide
└── .claude/                    # Claude Code configuration
    ├── settings.json           # Shared project settings
    ├── agents/                 # 12 project-specific agents
    └── commands/               # Workflow automation commands
```

## Tech Stack

- **Framework**: Wails (Go backend + React frontend via system WebView)
- **Frontend**: React 19 + Vite + TypeScript
- **Backend**: Go 1.25+
- **State**: Zustand
- **Editor**: CodeMirror 6
- **Terminal**: xterm.js + PTY
- **Testing**: Jest + ts-jest (frontend), Go test (backend)
- **File Watching**: fsnotify with debounce (no polling)

## Key Architecture Concepts

### Workspace Model
One repository can contain multiple focused workspaces (e.g., `frontend/`, `backend/python/`, `backend/go/`), each with:
- Independent layout state (panes, tabs, splits)
- Independent Run Profiles (build/lint/test/deploy commands)
- Independent language services scope (only active workspace runs LSP servers)

### Run Profiles
Lightweight run configurations as first-class citizens:
- Commands with working directory, env vars, env files
- Auto-detection from package.json, pyproject.toml, go.mod, Makefile, docker-compose
- Process executor with lifecycle management (start, stop, restart, SIGTERM grace period)
- Real-time output streaming with line assembly
- Status badges (RUNNING, PASSED, FAILED, READY, STOPPING, STOPPED)
- Auto-expand for active states, click-to-expand for completed
- Purpose-built expanded panels per state (output preview, stats, error detail, stop progress)
- Predicted completion ETA with median-based estimation
- Pin/unpin profiles, hide/unhide, profile browser
- First-class execution identity: output, lifecycle, and status route by `runInstanceId`, and the two most recent ordinary executions per profile are retained as diffable tabs

### Language Intelligence
Only the active workspace runs language servers. Missing servers are provisioned lazily into `~/.firn/servers` from pinned, checksum-verified artifacts (`basedpyright`, `gopls`, `typescript-language-server`, `rust-analyzer`) — never into the global `PATH` or project dependencies.

### Git Integration
Working-tree status, branch switching, side-by-side and editable diffs, hunk-level staging with intent-to-add, and a CodeMirror merge-resolution surface for conflicts. Merge sessions never write or stage until every region is resolved, and closing the surface is non-destructive.

### Performance Budgets
- Cold start: < 2-4 seconds
- Idle CPU: near 0% (no polling)
- Core RAM: ~200-450MB (without language servers)
- Only one workspace's language servers run at a time

## Development Principles
- Reference .claude/workflow.md regarding workflow orchestration

From `commands/code-review.md`:
- No hard-coded, fallback, stub, or placeholder data - all values must be dynamically derived
- Review/fix cycle continues until no issues found
- All code must be production-ready

From `commands/create-plan.md`:
- Create detailed implementation strategies for parallel agent execution
- Perform code review after each phase
- Proper error/message handling when data is unavailable

## Agents

Project-specific agents in `.claude/agents/`:
- `frontend-developer` - React/TypeScript UI
- `backend-developer` - Go backend
- `ui-designer` - Interface design
- `typescript-pro` - TypeScript expertise
- `golang-pro` - Go expertise
- `react-specialist` - React patterns
- `code-reviewer` - Code quality
- `debugger` - Issue diagnosis
- `performance-engineer` - Optimization
- `architect-reviewer` - Architecture
- `accessibility-tester` - WCAG compliance
- `dx-optimizer` - Developer experience
