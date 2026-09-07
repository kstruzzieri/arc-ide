package workspace

import (
	"errors"
	"firn/internal/filesystem"
	"io/fs"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// fsFromPaths builds a mock filesystem from a set of file paths. Intermediate
// directories are inferred. ReadDir returns immediate children (dirs + files).
func fsFromPaths(files ...string) *filesystem.Mock {
	fileContents := map[string][]byte{}
	for _, f := range files {
		path := filepath.Clean(filepath.FromSlash(f))
		if filepath.Base(path) == "package.json" {
			fileContents[path] = []byte(`{"devDependencies":{"vite":"5.0.0"}}`)
			continue
		}
		fileContents[path] = nil
	}
	return fsFromFileContents(fileContents, nil, nil)
}

func fsFromFileContents(fileContents map[string][]byte, readErrors map[string]error, readCount *int) *filesystem.Mock {
	return &filesystem.Mock{
		ReadDirFunc: func(dir string) ([]fs.DirEntry, error) {
			prefix := filepath.Clean(dir) + string(filepath.Separator)
			childDirs := map[string]bool{}
			var entries []fs.DirEntry
			for f := range fileContents {
				if !strings.HasPrefix(f, prefix) {
					continue
				}
				parts := strings.SplitN(strings.TrimPrefix(f, prefix), string(filepath.Separator), 2)
				if len(parts) == 1 {
					entries = append(entries, &mockEntry{name: parts[0], dir: false})
				} else {
					childDirs[parts[0]] = true
				}
			}
			for d := range childDirs {
				entries = append(entries, &mockEntry{name: d, dir: true})
			}
			return entries, nil
		},
		ReadFileFunc: func(path string) ([]byte, error) {
			if readCount != nil {
				*readCount++
			}
			path = filepath.Clean(path)
			if err := readErrors[path]; err != nil {
				return nil, err
			}
			data, ok := fileContents[path]
			if !ok {
				return nil, fs.ErrNotExist
			}
			return data, nil
		},
	}
}

type mockEntry struct {
	name string
	dir  bool
}

func (e *mockEntry) Name() string               { return e.name }
func (e *mockEntry) IsDir() bool                { return e.dir }
func (e *mockEntry) Type() fs.FileMode          { return 0 }
func (e *mockEntry) Info() (fs.FileInfo, error) { return nil, nil }

func TestDetectWorkspaces(t *testing.T) {
	root := filepath.FromSlash("/repo")
	project := WorkspaceDef{ID: "project", Name: "Project", RelDir: "", Type: TypeProject, Accent: "project"}
	tests := []struct {
		name  string
		files []string
		want  []WorkspaceDef
	}{
		{
			name:  "empty repo yields only project",
			files: []string{"/repo/README.md"},
			want:  []WorkspaceDef{project},
		},
		{
			name:  "frontend subdir",
			files: []string{"/repo/frontend/package.json"},
			want: []WorkspaceDef{
				project,
				{ID: "frontend", Name: "Frontend", RelDir: "frontend", Type: TypeFrontend, Accent: "frontend"},
			},
		},
		{
			name:  "root go.mod is a typed entry beside project",
			files: []string{"/repo/go.mod"},
			want: []WorkspaceDef{
				project,
				{ID: "root:go", Name: "Go", RelDir: "", Type: TypeGo, Accent: "go"},
			},
		},
		{
			name: "nested depth-2 go and python",
			files: []string{
				"/repo/backend/go/go.mod",
				"/repo/backend/py/pyproject.toml",
			},
			want: []WorkspaceDef{
				project,
				{ID: "backend/go", Name: "Go", RelDir: "backend/go", Type: TypeGo, Accent: "go"},
				{ID: "backend/py", Name: "Python", RelDir: "backend/py", Type: TypePython, Accent: "python"},
			},
		},
		{
			name:  "infra by docker-compose",
			files: []string{"/repo/infra/docker-compose.yml"},
			want: []WorkspaceDef{
				project,
				{ID: "infra", Name: "Docker", RelDir: "infra", Type: TypeDocker, Accent: "docker"},
			},
		},
		{
			name:  "infra by .tf suffix",
			files: []string{"/repo/terraform/main.tf"},
			want: []WorkspaceDef{
				project,
				{ID: "terraform", Name: "Terraform", RelDir: "terraform", Type: TypeTerraform, Accent: "terraform"},
			},
		},
		{
			name:  "compose-only root classifies as Docker",
			files: []string{"/repo/docker-compose.yml"},
			want: []WorkspaceDef{
				project,
				{ID: "root:docker", Name: "Docker", RelDir: "", Type: TypeDocker, Accent: "docker"},
			},
		},
		{
			name:  "ignored dirs are skipped",
			files: []string{"/repo/node_modules/foo/package.json", "/repo/app/package.json"},
			want: []WorkspaceDef{
				project,
				{ID: "app", Name: "Frontend", RelDir: "app", Type: TypeFrontend, Accent: "frontend"},
			},
		},
		{
			name: "depth-1 workspace with depth-2 child workspace yields both",
			files: []string{
				"/repo/backend/go.mod",
				"/repo/backend/api/go.mod",
			},
			want: []WorkspaceDef{
				project,
				{ID: "backend", Name: "Go (backend)", RelDir: "backend", Type: TypeGo, Accent: "go"},
				{ID: "backend/api", Name: "Go (backend/api)", RelDir: "backend/api", Type: TypeGo, Accent: "go"},
			},
		},
		{
			name:  "multiple root markers pick the highest priority",
			files: []string{"/repo/package.json", "/repo/go.mod"},
			want: []WorkspaceDef{
				project,
				{ID: "root:go", Name: "Go", RelDir: "", Type: TypeGo, Accent: "go"},
			},
		},
		{
			name:  "root marker id does not collide with matching subdir",
			files: []string{"/repo/package.json", "/repo/frontend/package.json"},
			want: []WorkspaceDef{
				project,
				{ID: "root:frontend", Name: "Frontend (root)", RelDir: "", Type: TypeFrontend, Accent: "frontend"},
				{ID: "frontend", Name: "Frontend (frontend)", RelDir: "frontend", Type: TypeFrontend, Accent: "frontend"},
			},
		},
		{
			name: "wails root: go.mod beats tooling package.json, frontend subdir distinct",
			files: []string{
				"/repo/go.mod",
				"/repo/package.json",
				"/repo/frontend/package.json",
			},
			want: []WorkspaceDef{
				project,
				{ID: "root:go", Name: "Go", RelDir: "", Type: TypeGo, Accent: "go"},
				{ID: "frontend", Name: "Frontend", RelDir: "frontend", Type: TypeFrontend, Accent: "frontend"},
			},
		},
		{
			name: "hidden/dot dirs are skipped (e.g. .worktrees copies)",
			files: []string{
				"/repo/.worktrees/wt/package.json",
				"/repo/app/package.json",
			},
			want: []WorkspaceDef{
				project,
				{ID: "app", Name: "Frontend", RelDir: "app", Type: TypeFrontend, Accent: "frontend"},
			},
		},
		{
			name: "two same-type subdirs get disambiguated names",
			files: []string{
				"/repo/web/package.json",
				"/repo/admin/package.json",
			},
			want: []WorkspaceDef{
				project,
				{ID: "admin", Name: "Frontend (admin)", RelDir: "admin", Type: TypeFrontend, Accent: "frontend"},
				{ID: "web", Name: "Frontend (web)", RelDir: "web", Type: TypeFrontend, Accent: "frontend"},
			},
		},
		{
			name: "frontend that ships a Dockerfile stays Frontend (infra never shadows a language)",
			files: []string{
				"/repo/frontend/package.json",
				"/repo/frontend/Dockerfile",
				"/repo/frontend/nginx.conf",
			},
			want: []WorkspaceDef{
				project,
				{ID: "frontend", Name: "Frontend", RelDir: "frontend", Type: TypeFrontend, Accent: "frontend"},
			},
		},
		{
			name: "python service with a Dockerfile stays Python",
			files: []string{
				"/repo/api/pyproject.toml",
				"/repo/api/Dockerfile",
			},
			want: []WorkspaceDef{
				project,
				{ID: "api", Name: "Python", RelDir: "api", Type: TypePython, Accent: "python"},
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := DetectWorkspaces(fsFromPaths(tc.files...), root)
			if err != nil {
				t.Fatalf("DetectWorkspaces returned error: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("mismatch\n got: %+v\nwant: %+v", got, tc.want)
			}
		})
	}
}

func TestPackageJSONClassification(t *testing.T) {
	const root = "/repo"
	packagePath := filepath.FromSlash("/repo/package.json")

	frontendCases := []struct {
		name     string
		manifest string
	}{
		{"react dependency", `{"dependencies":{"react":"1"}}`},
		{"vue dependency", `{"dependencies":{"vue":"1"}}`},
		{"svelte dependency", `{"dependencies":{"svelte":"1"}}`},
		{"angular dependency", `{"dependencies":{"@angular/core":"1"}}`},
		{"next dependency", `{"dependencies":{"next":"1"}}`},
		{"astro dependency", `{"dependencies":{"astro":"1"}}`},
		{"solid dependency", `{"dependencies":{"solid-js":"1"}}`},
		{"vite dependency", `{"dependencies":{"vite":"1"}}`},
		{"react devDependency", `{"devDependencies":{"react":"1"}}`},
		{"vue devDependency", `{"devDependencies":{"vue":"1"}}`},
		{"svelte devDependency", `{"devDependencies":{"svelte":"1"}}`},
		{"angular devDependency", `{"devDependencies":{"@angular/core":"1"}}`},
		{"next devDependency", `{"devDependencies":{"next":"1"}}`},
		{"astro devDependency", `{"devDependencies":{"astro":"1"}}`},
		{"solid devDependency", `{"devDependencies":{"solid-js":"1"}}`},
		{"vite devDependency", `{"devDependencies":{"vite":"1"}}`},
	}
	for _, tc := range frontendCases {
		t.Run(tc.name, func(t *testing.T) {
			reads := 0
			fsys := fsFromFileContents(map[string][]byte{packagePath: []byte(tc.manifest)}, nil, &reads)
			typ, accent, ok := classifyDir(fsys, filepath.FromSlash(root))
			if typ != TypeFrontend || accent != "frontend" || !ok {
				t.Fatalf("classifyDir = (%q, %q, %t), want frontend/frontend/true", typ, accent, ok)
			}
			if reads != 1 {
				t.Fatalf("package.json reads = %d, want 1", reads)
			}
		})
	}

	nodeCases := []struct {
		name      string
		manifest  []byte
		readError error
	}{
		{"server and tooling dependencies", []byte(`{"dependencies":{"express":"1"},"devDependencies":{"typescript":"1","eslint":"1"}}`), nil},
		{"dependency-less manifest", []byte(`{"name":"service"}`), nil},
		{"empty dependency maps", []byte(`{"dependencies":{},"devDependencies":{}}`), nil},
		{"capitalized dependencies ignored", []byte(`{"Dependencies":{"react":"1"}}`), nil},
		{"capitalized devDependencies ignored", []byte(`{"DevDependencies":{"vite":"1"}}`), nil},
		{"malformed manifest", []byte(`{"dependencies":`), nil},
		{"unreadable manifest", nil, errors.New("read denied")},
	}
	for _, tc := range nodeCases {
		t.Run(tc.name, func(t *testing.T) {
			reads := 0
			fsys := fsFromFileContents(
				map[string][]byte{packagePath: tc.manifest},
				map[string]error{packagePath: tc.readError},
				&reads,
			)
			typ, accent, ok := classifyDir(fsys, filepath.FromSlash(root))
			if typ != WorkspaceType("node") || accent != "node" || !ok {
				t.Fatalf("classifyDir = (%q, %q, %t), want node/node/true", typ, accent, ok)
			}
			if reads != 1 {
				t.Fatalf("package.json reads = %d, want 1", reads)
			}
		})
	}

	t.Run("package beats infrastructure", func(t *testing.T) {
		reads := 0
		fsys := fsFromFileContents(map[string][]byte{
			packagePath:                            []byte(`{"name":"service"}`),
			filepath.FromSlash("/repo/Dockerfile"): nil,
		}, nil, &reads)
		typ, accent, ok := classifyDir(fsys, filepath.FromSlash(root))
		if typ != WorkspaceType("node") || accent != "node" || !ok {
			t.Fatalf("classifyDir = (%q, %q, %t), want node/node/true", typ, accent, ok)
		}
		if reads != 1 {
			t.Fatalf("package.json reads = %d, want 1", reads)
		}
	})

	for _, marker := range []string{"go.mod", "pyproject.toml"} {
		t.Run(marker+" beats package without reading it", func(t *testing.T) {
			reads := 0
			fsys := fsFromFileContents(map[string][]byte{
				packagePath:                           []byte(`{"dependencies":{"react":"1"}}`),
				filepath.FromSlash("/repo/" + marker): nil,
			}, nil, &reads)
			typ, _, ok := classifyDir(fsys, filepath.FromSlash(root))
			if !ok {
				t.Fatal("classifyDir did not classify the directory")
			}
			if (marker == "go.mod" && typ != TypeGo) || (marker == "pyproject.toml" && typ != TypePython) {
				t.Fatalf("classifyDir type = %q, want marker %s to win", typ, marker)
			}
			if reads != 0 {
				t.Fatalf("package.json reads = %d, want 0", reads)
			}
		})
	}

	t.Run("root and subdirectory IDs stay stable", func(t *testing.T) {
		reads := 0
		fsys := fsFromFileContents(map[string][]byte{
			packagePath: []byte(`{"name":"root-service"}`),
			filepath.FromSlash("/repo/services/api/package.json"): []byte(`{"name":"api-service"}`),
		}, nil, &reads)
		got, err := DetectWorkspaces(fsys, filepath.FromSlash(root))
		if err != nil {
			t.Fatalf("DetectWorkspaces returned error: %v", err)
		}
		want := []WorkspaceDef{
			{ID: "project", Name: "Project", RelDir: "", Type: TypeProject, Accent: "project"},
			{ID: "root:node", Name: "Node (root)", RelDir: "", Type: WorkspaceType("node"), Accent: "node"},
			{ID: "services/api", Name: "Node (services/api)", RelDir: "services/api", Type: WorkspaceType("node"), Accent: "node"},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("mismatch\n got: %+v\nwant: %+v", got, want)
		}
		if reads != 2 {
			t.Fatalf("package.json reads = %d, want 2", reads)
		}
	})
}
