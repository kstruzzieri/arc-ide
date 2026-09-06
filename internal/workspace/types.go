// Package workspace provides workspace state persistence for Firn IDE.
// Workspace state (open files, panel layout, cursor positions) is saved to
// ~/.firn/workspaces/ so sessions can be restored across app restarts.
package workspace

import "firn/internal/filesystem"

// StateFile is the on-disk JSON format with a version envelope.
type StateFile struct {
	Version int   `json:"version"`
	State   State `json:"state"`
}

// State is the complete persisted state for one workspace.
type State struct {
	WorkspacePath     string      `json:"workspacePath"`
	WorkspaceName     string      `json:"workspaceName"`
	LastOpened        string      `json:"lastOpened"` // RFC 3339
	Layout            Layout      `json:"layout"`
	Editor            EditorState `json:"editor"`
	Explorer          Explorer    `json:"explorer"`
	ActiveSidebar     string      `json:"activeSidebar"`
	HiddenProfileIDs  []string    `json:"hiddenProfileIds,omitempty"`
	ActiveWorkspaceID string      `json:"activeWorkspaceId,omitempty"`
	LSP               LSPState    `json:"lsp,omitempty"`
}

// LSPState holds machine-local LSP overrides for a workspace. Persisted under
// ~/.firn/workspaces (never in the repo) because interpreter/server paths are
// machine-specific.
type LSPState struct {
	InterpreterOverride string            `json:"interpreterOverride,omitempty"`
	ServerPathOverride  map[string]string `json:"serverPathOverride,omitempty"` // family -> path (reserved)
}

// Layout captures panel sizes and collapsed states.
//
// The #271 center-pair fields are additive and omitempty so files written
// before them stay valid; the envelope Version stays 1. GolemCollapsed is a
// pointer because its default is true (Golem is opt-in): a plain omitempty
// bool could not distinguish "saved false" from "absent".
type Layout struct {
	PanelSizes      PanelSizes `json:"panelSizes"`
	LeftCollapsed   bool       `json:"leftCollapsed"`
	RightCollapsed  bool       `json:"rightCollapsed"`
	BottomCollapsed bool       `json:"bottomCollapsed"`
	CenterOrder     string     `json:"centerOrder,omitempty"`    // "" | "files-first" | "golem-first"
	GolemCollapsed  *bool      `json:"golemCollapsed,omitempty"` // nil = absent (frontend default: collapsed)
	FilesCollapsed  bool       `json:"filesCollapsed,omitempty"`
}

// PanelSizes stores pixel sizes for the resizable panels. Golem is the #271
// center island's preferred width; zero means "absent" (frontend default 420).
type PanelSizes struct {
	Left   int `json:"left"`
	Right  int `json:"right"`
	Bottom int `json:"bottom"`
	Golem  int `json:"golem,omitempty"`
}

// EditorState captures open files and the active tab.
type EditorState struct {
	ActiveFilePath string      `json:"activeFilePath"`
	OpenFiles      []FileState `json:"openFiles"`
}

// FileState captures per-file cursor and scroll position.
type FileState struct {
	Path         string `json:"path"`
	CursorLine   int    `json:"cursorLine"`
	CursorColumn int    `json:"cursorColumn"`
	ScrollTop    int    `json:"scrollTop"`
}

// Explorer captures file tree expand/collapse state.
type Explorer struct {
	ExpandedPaths []string               `json:"expandedPaths"`
	RootExpanded  bool                   `json:"rootExpanded"`
	TreeSnapshot  []filesystem.FileEntry `json:"treeSnapshot,omitempty"`
}

// Summary is a lightweight struct for listing recent workspaces.
type Summary struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	LastOpened string `json:"lastOpened"`
}

// WorkspaceType identifies the kind of a detected workspace.
type WorkspaceType string

const (
	TypeProject   WorkspaceType = "project"
	TypeFrontend  WorkspaceType = "frontend"
	TypeNode      WorkspaceType = "node"
	TypeGo        WorkspaceType = "go"
	TypePython    WorkspaceType = "python"
	TypeDocker    WorkspaceType = "docker"
	TypeTerraform WorkspaceType = "terraform"
	TypeGeneral   WorkspaceType = "general" // reserved; no marker produces it yet
)

// WorkspaceDef is a detected (or synthetic) focused context within a repo.
// The synthetic "Project" entry represents the whole repo with a neutral accent.
type WorkspaceDef struct {
	ID     string        `json:"id"`     // "project" | relDir | "root:<type>" for root markers
	Name   string        `json:"name"`   // human label, e.g. "Project", "Frontend"
	RelDir string        `json:"relDir"` // "" for project + root-level markers
	Type   WorkspaceType `json:"type"`
	// Accent is named for the workspace type, 1:1 with Type, and must match a
	// --accent-* token in frontend/src/styles/tokens.css and the WorkspaceAccent
	// union in frontend/src/stores/ideStore.ts.
	Accent string `json:"accent"` // project|frontend|node|python|go|rust|docker|terraform|general
}
