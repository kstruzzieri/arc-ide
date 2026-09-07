package workspace

import (
	"encoding/json"
	"errors"
	"firn/internal/filesystem"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

var testWorkspaceBaseDir = filepath.FromSlash("/home/user/.firn/workspaces")

// Keys are compared byte-for-byte, exactly as a real filesystem would. Do not
// normalize the paths production hands this mock: separator mistakes on Windows
// are the whole reason the scoped Windows job exists, and canonicalizing them
// here would launder them away. Fixtures must be built with filepath.Join.
func newMockFS() *filesystem.Mock {
	files := map[string][]byte{}
	dirs := map[string]bool{}

	return &filesystem.Mock{
		ReadFileFunc: func(path string) ([]byte, error) {
			data, ok := files[path]
			if !ok {
				return nil, fs.ErrNotExist
			}
			return data, nil
		},
		WriteFileFunc: func(path string, data []byte, perm fs.FileMode) error {
			files[path] = data
			return nil
		},
		RemoveFunc: func(path string) error {
			delete(files, path)
			return nil
		},
		RenameFunc: func(oldPath, newPath string) error {
			data, ok := files[oldPath]
			if !ok {
				return fs.ErrNotExist
			}
			files[newPath] = data
			delete(files, oldPath)
			return nil
		},
		MkdirAllFunc: func(path string, perm fs.FileMode) error {
			dirs[path] = true
			return nil
		},
		ReadDirFunc: func(path string) ([]fs.DirEntry, error) {
			if !dirs[path] {
				// Any descendant, not just an immediate child: an unrecorded
				// directory still exists if something lives anywhere below it.
				hasFiles := false
				prefix := path + string(filepath.Separator)
				for k := range files {
					if strings.HasPrefix(k, prefix) {
						hasFiles = true
						break
					}
				}
				if !hasFiles {
					return nil, fs.ErrNotExist
				}
			}

			var entries []fs.DirEntry
			for k := range files {
				if filepath.Dir(k) == path {
					entries = append(entries, &mockDirEntry{name: filepath.Base(k), isDir: false})
				}
			}
			return entries, nil
		},
	}
}

// mockDirEntry implements fs.DirEntry for testing.
type mockDirEntry struct {
	name  string
	isDir bool
}

func (e *mockDirEntry) Name() string               { return e.name }
func (e *mockDirEntry) IsDir() bool                { return e.isDir }
func (e *mockDirEntry) Type() fs.FileMode          { return 0 }
func (e *mockDirEntry) Info() (fs.FileInfo, error) { return nil, nil }

func testState(path, name string) State {
	return State{
		WorkspacePath: path,
		WorkspaceName: name,
		Layout: Layout{
			PanelSizes:      PanelSizes{Left: 260, Right: 280, Bottom: 200},
			LeftCollapsed:   false,
			RightCollapsed:  true,
			BottomCollapsed: false,
		},
		Editor: EditorState{
			ActiveFilePath: "/project/main.go",
			OpenFiles: []FileState{
				{Path: "/project/main.go", CursorLine: 42, CursorColumn: 15, ScrollTop: 120},
				{Path: "/project/app.go", CursorLine: 1, CursorColumn: 1, ScrollTop: 0},
			},
		},
		Explorer: Explorer{
			ExpandedPaths: []string{"/project/internal", "/project/frontend"},
			RootExpanded:  true,
			TreeSnapshot: []filesystem.FileEntry{
				{
					Name:  "src",
					Path:  "/project/src",
					IsDir: true,
					Children: []filesystem.FileEntry{
						{
							Name:  "main.go",
							Path:  "/project/src/main.go",
							IsDir: false,
						},
					},
				},
			},
		},
		ActiveSidebar: "explorer",
	}
}

func TestStoreLoadNoFile(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, testWorkspaceBaseDir)

	state, err := store.Load("/some/workspace")
	if err != nil {
		t.Fatalf("Load() returned error: %v", err)
	}
	if state != nil {
		t.Error("expected nil state for missing file")
	}
}

func TestStoreLoadUnsupportedVersion(t *testing.T) {
	mockFS := newMockFS()
	sf := StateFile{
		Version: 99,
		State:   testState("/project", "project"),
	}
	data, _ := json.Marshal(sf)
	id := pathToID("/project")
	_ = mockFS.WriteFile(filepath.Join(testWorkspaceBaseDir, id+".json"), data, 0o644)

	store := NewStore(mockFS, testWorkspaceBaseDir)
	_, err := store.Load("/project")
	if err == nil {
		t.Fatal("expected error for unsupported version")
	}
	if !strings.Contains(err.Error(), "unsupported workspace state version") {
		t.Errorf("expected version error, got: %v", err)
	}
}

func TestStoreLoadMalformedJSON(t *testing.T) {
	mockFS := newMockFS()
	id := pathToID("/project")
	_ = mockFS.WriteFile(filepath.Join(testWorkspaceBaseDir, id+".json"), []byte("{invalid"), 0o644)

	store := NewStore(mockFS, testWorkspaceBaseDir)
	_, err := store.Load("/project")
	if err == nil {
		t.Fatal("expected error for malformed JSON")
	}
	if !strings.Contains(err.Error(), "parsing workspace state file") {
		t.Errorf("expected parse error, got: %v", err)
	}
}

func TestStoreLoadValidFile(t *testing.T) {
	mockFS := newMockFS()
	original := testState("/project", "project")
	original.LastOpened = "2026-03-08T12:00:00Z"
	sf := StateFile{Version: 1, State: original}
	data, _ := json.Marshal(sf)
	id := pathToID("/project")
	_ = mockFS.WriteFile(filepath.Join(testWorkspaceBaseDir, id+".json"), data, 0o644)

	store := NewStore(mockFS, testWorkspaceBaseDir)
	state, err := store.Load("/project")
	if err != nil {
		t.Fatalf("Load() returned error: %v", err)
	}
	if state == nil {
		t.Fatal("expected non-nil state")
	}
	if state.WorkspacePath != "/project" {
		t.Errorf("expected path '/project', got %q", state.WorkspacePath)
	}
	if state.WorkspaceName != "project" {
		t.Errorf("expected name 'project', got %q", state.WorkspaceName)
	}
	if len(state.Editor.OpenFiles) != 2 {
		t.Errorf("expected 2 open files, got %d", len(state.Editor.OpenFiles))
	}
	if state.Editor.OpenFiles[0].CursorLine != 42 {
		t.Errorf("expected cursor line 42, got %d", state.Editor.OpenFiles[0].CursorLine)
	}
	if state.Layout.RightCollapsed != true {
		t.Error("expected right panel collapsed")
	}
	if len(state.Explorer.ExpandedPaths) != 2 {
		t.Errorf("expected 2 expanded paths, got %d", len(state.Explorer.ExpandedPaths))
	}
	if len(state.Explorer.TreeSnapshot) != 1 || state.Explorer.TreeSnapshot[0].Name != "src" {
		t.Errorf("expected tree snapshot to round-trip, got %+v", state.Explorer.TreeSnapshot)
	}
}

func TestStoreSaveCreatesFile(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, testWorkspaceBaseDir)

	state := testState("/project", "project")
	if err := store.Save(state); err != nil {
		t.Fatalf("Save() returned error: %v", err)
	}

	// Verify file was written
	id := pathToID("/project")
	data, err := mockFS.ReadFile(filepath.Join(testWorkspaceBaseDir, id+".json"))
	if err != nil {
		t.Fatalf("state file not found: %v", err)
	}

	var sf StateFile
	if err := json.Unmarshal(data, &sf); err != nil {
		t.Fatalf("failed to parse written file: %v", err)
	}
	if sf.Version != 1 {
		t.Errorf("expected version 1, got %d", sf.Version)
	}
	if sf.State.WorkspacePath != "/project" {
		t.Errorf("expected path '/project', got %q", sf.State.WorkspacePath)
	}
	if sf.State.LastOpened == "" {
		t.Error("expected LastOpened to be set")
	}
}

func TestStoreSaveOverwrites(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, testWorkspaceBaseDir)

	state := testState("/project", "project")
	_ = store.Save(state)

	state.WorkspaceName = "updated-name"
	_ = store.Save(state)

	loaded, err := store.Load("/project")
	if err != nil {
		t.Fatalf("Load() returned error: %v", err)
	}
	if loaded.WorkspaceName != "updated-name" {
		t.Errorf("expected updated name, got %q", loaded.WorkspaceName)
	}
}

func TestStoreSaveEmptyPathError(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, testWorkspaceBaseDir)

	err := store.Save(State{})
	if err == nil {
		t.Fatal("expected error for empty workspace path")
	}
	if !strings.Contains(err.Error(), "must not be empty") {
		t.Errorf("expected empty path error, got: %v", err)
	}
}

func TestStoreSaveNilSlicesBecomeEmpty(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, testWorkspaceBaseDir)

	state := State{
		WorkspacePath: "/project",
		WorkspaceName: "project",
		Editor:        EditorState{OpenFiles: nil},
		Explorer:      Explorer{ExpandedPaths: nil},
	}
	_ = store.Save(state)

	id := pathToID("/project")
	data, _ := mockFS.ReadFile(filepath.Join(testWorkspaceBaseDir, id+".json"))

	// Verify [] not null in JSON
	if strings.Contains(string(data), `"openFiles": null`) {
		t.Error("openFiles should serialize as [] not null")
	}
	if strings.Contains(string(data), `"expandedPaths": null`) {
		t.Error("expandedPaths should serialize as [] not null")
	}
	if strings.Contains(string(data), `"treeSnapshot": null`) {
		t.Error("treeSnapshot should serialize as [] not null")
	}
}

func TestStoreRoundTrip(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, testWorkspaceBaseDir)

	original := testState("/project", "project")
	if err := store.Save(original); err != nil {
		t.Fatalf("Save() returned error: %v", err)
	}

	loaded, err := store.Load("/project")
	if err != nil {
		t.Fatalf("Load() returned error: %v", err)
	}
	if loaded == nil {
		t.Fatal("expected non-nil state")
	}

	// Compare key fields (LastOpened is set automatically so skip it)
	if loaded.WorkspacePath != original.WorkspacePath {
		t.Errorf("path mismatch: %q vs %q", loaded.WorkspacePath, original.WorkspacePath)
	}
	if loaded.Editor.ActiveFilePath != original.Editor.ActiveFilePath {
		t.Errorf("active file mismatch: %q vs %q", loaded.Editor.ActiveFilePath, original.Editor.ActiveFilePath)
	}
	if len(loaded.Editor.OpenFiles) != len(original.Editor.OpenFiles) {
		t.Errorf("open files count mismatch: %d vs %d", len(loaded.Editor.OpenFiles), len(original.Editor.OpenFiles))
	}
	if loaded.Layout.PanelSizes.Left != original.Layout.PanelSizes.Left {
		t.Errorf("panel size mismatch: %d vs %d", loaded.Layout.PanelSizes.Left, original.Layout.PanelSizes.Left)
	}
	if loaded.ActiveSidebar != original.ActiveSidebar {
		t.Errorf("sidebar mismatch: %q vs %q", loaded.ActiveSidebar, original.ActiveSidebar)
	}
}

func TestPathToIDDeterministic(t *testing.T) {
	id1 := pathToID("/project/one")
	id2 := pathToID("/project/one")
	if id1 != id2 {
		t.Errorf("pathToID should be deterministic: %q vs %q", id1, id2)
	}
}

func TestPathToIDDifferentPaths(t *testing.T) {
	id1 := pathToID("/project/one")
	id2 := pathToID("/project/two")
	if id1 == id2 {
		t.Errorf("different paths should produce different IDs: both %q", id1)
	}
}

func TestPathToIDNormalizesTrailingSlash(t *testing.T) {
	id1 := pathToID("/project/one")
	id2 := pathToID("/project/one/")
	if id1 != id2 {
		t.Errorf("trailing slash should not change ID: %q vs %q", id1, id2)
	}
}

func TestListRecentEmpty(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, testWorkspaceBaseDir)

	summaries, err := store.ListRecent(10)
	if err != nil {
		t.Fatalf("ListRecent() returned error: %v", err)
	}
	if len(summaries) != 0 {
		t.Errorf("expected empty list, got %d", len(summaries))
	}
}

func TestListRecentMultiple(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, testWorkspaceBaseDir)

	// Save three workspaces with different timestamps
	s1 := testState("/project/a", "project-a")
	s1.LastOpened = "2026-03-01T12:00:00Z"
	sf1 := StateFile{Version: 1, State: s1}
	data1, _ := json.Marshal(sf1)
	_ = mockFS.WriteFile(filepath.Join(testWorkspaceBaseDir, pathToID("/project/a")+".json"), data1, 0o644)
	_ = mockFS.MkdirAll(testWorkspaceBaseDir, 0o755)

	s2 := testState("/project/b", "project-b")
	s2.LastOpened = "2026-03-08T12:00:00Z"
	sf2 := StateFile{Version: 1, State: s2}
	data2, _ := json.Marshal(sf2)
	_ = mockFS.WriteFile(filepath.Join(testWorkspaceBaseDir, pathToID("/project/b")+".json"), data2, 0o644)

	s3 := testState("/project/c", "project-c")
	s3.LastOpened = "2026-03-05T12:00:00Z"
	sf3 := StateFile{Version: 1, State: s3}
	data3, _ := json.Marshal(sf3)
	_ = mockFS.WriteFile(filepath.Join(testWorkspaceBaseDir, pathToID("/project/c")+".json"), data3, 0o644)

	summaries, err := store.ListRecent(10)
	if err != nil {
		t.Fatalf("ListRecent() returned error: %v", err)
	}
	if len(summaries) != 3 {
		t.Fatalf("expected 3 summaries, got %d", len(summaries))
	}

	// Should be sorted most recent first
	if summaries[0].Name != "project-b" {
		t.Errorf("expected most recent first (project-b), got %q", summaries[0].Name)
	}
	if summaries[1].Name != "project-c" {
		t.Errorf("expected second (project-c), got %q", summaries[1].Name)
	}
	if summaries[2].Name != "project-a" {
		t.Errorf("expected last (project-a), got %q", summaries[2].Name)
	}
}

func TestListRecentWithLimit(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, testWorkspaceBaseDir)

	for _, name := range []string{"a", "b", "c"} {
		s := testState("/project/"+name, "project-"+name)
		sf := StateFile{Version: 1, State: s}
		data, _ := json.Marshal(sf)
		_ = mockFS.WriteFile(filepath.Join(testWorkspaceBaseDir, pathToID("/project/"+name)+".json"), data, 0o644)
	}
	_ = mockFS.MkdirAll(testWorkspaceBaseDir, 0o755)

	summaries, err := store.ListRecent(2)
	if err != nil {
		t.Fatalf("ListRecent() returned error: %v", err)
	}
	if len(summaries) != 2 {
		t.Errorf("expected 2 summaries with limit, got %d", len(summaries))
	}
}

func TestListRecentSkipsCorruptFiles(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, testWorkspaceBaseDir)

	// Write a valid file
	s := testState("/project", "project")
	s.LastOpened = "2026-03-08T12:00:00Z"
	sf := StateFile{Version: 1, State: s}
	data, _ := json.Marshal(sf)
	_ = mockFS.WriteFile(filepath.Join(testWorkspaceBaseDir, "valid.json"), data, 0o644)

	// Write a corrupt file
	_ = mockFS.WriteFile(filepath.Join(testWorkspaceBaseDir, "corrupt.json"), []byte("{bad}"), 0o644)

	_ = mockFS.MkdirAll(testWorkspaceBaseDir, 0o755)

	summaries, err := store.ListRecent(10)
	if err != nil {
		t.Fatalf("ListRecent() returned error: %v", err)
	}
	if len(summaries) != 1 {
		t.Errorf("expected 1 summary (corrupt skipped), got %d", len(summaries))
	}
}

func TestStoreSaveMkdirFails(t *testing.T) {
	mockFS := &filesystem.Mock{
		MkdirAllFunc: func(path string, perm fs.FileMode) error {
			return errors.New("permission denied")
		},
	}
	store := NewStore(mockFS, testWorkspaceBaseDir)

	err := store.Save(testState("/project", "project"))
	if err == nil {
		t.Fatal("expected error when MkdirAll fails")
	}
	if !strings.Contains(err.Error(), "creating workspaces directory") {
		t.Errorf("expected directory error, got: %v", err)
	}
}

func TestStoreSaveWriteFails(t *testing.T) {
	mockFS := &filesystem.Mock{
		MkdirAllFunc: func(path string, perm fs.FileMode) error {
			return nil
		},
		WriteFileFunc: func(path string, data []byte, perm fs.FileMode) error {
			return errors.New("disk full")
		},
	}
	store := NewStore(mockFS, testWorkspaceBaseDir)

	err := store.Save(testState("/project", "project"))
	if err == nil {
		t.Fatal("expected error when WriteFile fails")
	}
	if !strings.Contains(err.Error(), "writing workspace state file") {
		t.Errorf("expected write error, got: %v", err)
	}
}

func TestStoreLoadReadFails(t *testing.T) {
	mockFS := &filesystem.Mock{
		ReadFileFunc: func(path string) ([]byte, error) {
			return nil, errors.New("I/O error")
		},
	}
	store := NewStore(mockFS, testWorkspaceBaseDir)

	_, err := store.Load("/project")
	if err == nil {
		t.Fatal("expected error when ReadFile fails")
	}
	if !strings.Contains(err.Error(), "reading workspace state file") {
		t.Errorf("expected read error, got: %v", err)
	}
}

func TestSaveLoad_ActiveWorkspaceID(t *testing.T) {
	store := NewStore(newMockFS(), testWorkspaceBaseDir)
	state := testState("/project", "project")
	state.ActiveWorkspaceID = "frontend"

	if err := store.Save(state); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}
	loaded, err := store.Load("/project")
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if loaded.ActiveWorkspaceID != "frontend" {
		t.Errorf("ActiveWorkspaceID = %q, want %q", loaded.ActiveWorkspaceID, "frontend")
	}
}

func TestState_LSPOverride_roundTrip(t *testing.T) {
	store := NewStore(newMockFS(), testWorkspaceBaseDir)
	state := State{
		WorkspacePath: "/ws",
		WorkspaceName: "ws",
		LSP: LSPState{
			InterpreterOverride: "/ws/.venv/bin/python",
			ServerPathOverride:  map[string]string{"python": "/usr/local/bin/pyright"},
		},
	}

	if err := store.Save(state); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}
	loaded, err := store.Load("/ws")
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if loaded.LSP.InterpreterOverride != "/ws/.venv/bin/python" {
		t.Errorf("InterpreterOverride = %q, want %q", loaded.LSP.InterpreterOverride, "/ws/.venv/bin/python")
	}
	if loaded.LSP.ServerPathOverride["python"] != "/usr/local/bin/pyright" {
		t.Errorf("ServerPathOverride[python] = %q, want %q", loaded.LSP.ServerPathOverride["python"], "/usr/local/bin/pyright")
	}
}

func TestState_absentLSP_isZeroValue(t *testing.T) {
	var st State
	if st.LSP.InterpreterOverride != "" || st.LSP.ServerPathOverride != nil {
		t.Error("zero State should have empty LSPState")
	}
}
