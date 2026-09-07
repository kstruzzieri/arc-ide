package workspace

import (
	"encoding/json"
	"firn/internal/filesystem"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// markerRule maps marker files in a directory to a workspace type + accent.
// Within a single rule, the file names and the optional suffix are OR-combined:
// a directory matches the rule if it contains any of files OR any file ending
// in suffix. Different match behavior for a different type is expressed by a
// separate rule entry, not by combining unrelated conditions in one rule.
type markerRule struct {
	files  []string // exact filenames
	suffix string   // optional suffix match, e.g. ".tf"
	typ    WorkspaceType
	accent string
}

// markerRules is evaluated in priority order; the first match classifies a dir.
// Language/project markers (go.mod, pyproject, package.json) rank ABOVE infra so
// a service that merely ships a Dockerfile keeps its real language identity;
// infra wins only for dirs with no language marker (pure terraform or
// compose-only orchestration). go.mod is first so a polyglot root with a tooling
// package.json classifies as Go.
// Accents are named for the workspace type, not the colour, and are 1:1 with it.
// The hex values live in frontend/src/styles/tokens.css.
var markerRules = []markerRule{
	{files: []string{"go.mod"}, typ: TypeGo, accent: "go"},
	{files: []string{"pyproject.toml", "requirements.txt", "setup.py"}, typ: TypePython, accent: "python"},
	{files: []string{"package.json"}, typ: TypeNode, accent: "node"},
	{files: []string{"docker-compose.yml", "docker-compose.yaml", "Dockerfile"}, typ: TypeDocker, accent: "docker"},
	{suffix: ".tf", typ: TypeTerraform, accent: "terraform"},
}

var frontendDependencies = map[string]bool{
	"react":         true,
	"vue":           true,
	"svelte":        true,
	"@angular/core": true,
	"next":          true,
	"astro":         true,
	"solid-js":      true,
	"vite":          true,
}

// ignoredDirs are never scanned or treated as workspaces.
var ignoredDirs = map[string]bool{
	"node_modules": true,
	".git":         true,
	"vendor":       true,
	"dist":         true,
	"build":        true,
	".firn":        true,
}

// DetectWorkspaces scans a repo for focused workspaces. The synthetic "Project"
// entry (whole repo, neutral accent) is always first. The repo root and its
// subdirectories up to depth 2 are classified by marker files. Read-only.
// Directories that cannot be read are silently skipped (best-effort scan).
func DetectWorkspaces(fsys filesystem.FileSystem, repoPath string) ([]WorkspaceDef, error) {
	result := []WorkspaceDef{projectWorkspace()}
	var detected []WorkspaceDef

	// Repo-root markers -> a typed entry at relDir "" with a namespaced ID.
	if typ, accent, ok := classifyDir(fsys, repoPath); ok {
		detected = append(detected, WorkspaceDef{
			ID:     rootWorkspaceID(typ),
			Name:   typeLabel(typ),
			RelDir: "",
			Type:   typ,
			Accent: accent,
		})
	}

	// Depth 1 + depth 2 subdirectories.
	for _, child := range subDirs(fsys, repoPath) {
		childAbs := filepath.Join(repoPath, child)
		if typ, accent, ok := classifyDir(fsys, childAbs); ok {
			detected = append(detected, workspaceForDir(child, typ, accent))
		}
		for _, grand := range subDirs(fsys, childAbs) {
			// path.Join (always forward-slash) keeps IDs/relDirs portable across
			// OSes; do not switch to filepath.Join here.
			grandRel := path.Join(child, grand)
			grandAbs := filepath.Join(childAbs, grand)
			if typ, accent, ok := classifyDir(fsys, grandAbs); ok {
				detected = append(detected, workspaceForDir(grandRel, typ, accent))
			}
		}
	}

	sort.SliceStable(detected, func(i, j int) bool {
		iRoot, jRoot := detected[i].RelDir == "", detected[j].RelDir == ""
		if iRoot != jRoot {
			return iRoot // root markers first
		}
		if iRoot {
			return detected[i].ID < detected[j].ID
		}
		return detected[i].RelDir < detected[j].RelDir
	})

	// Disambiguate duplicate display names (e.g. two Frontend subdirs) so tabs
	// are distinguishable. Single-of-a-kind names are left clean.
	nameCounts := map[string]int{}
	for _, d := range detected {
		nameCounts[d.Name]++
	}
	for i := range detected {
		if nameCounts[detected[i].Name] > 1 {
			loc := detected[i].RelDir
			if loc == "" {
				loc = "root"
			}
			detected[i].Name = detected[i].Name + " (" + loc + ")"
		}
	}

	return append(result, detected...), nil
}

func projectWorkspace() WorkspaceDef {
	return WorkspaceDef{ID: "project", Name: "Project", RelDir: "", Type: TypeProject, Accent: "project"}
}

func rootWorkspaceID(typ WorkspaceType) string {
	return "root:" + string(typ)
}

func workspaceForDir(relDir string, typ WorkspaceType, accent string) WorkspaceDef {
	return WorkspaceDef{ID: relDir, Name: typeLabel(typ), RelDir: relDir, Type: typ, Accent: accent}
}

// subDirs returns the names of non-ignored immediate subdirectories of dir.
func subDirs(fsys filesystem.FileSystem, dir string) []string {
	entries, err := fsys.ReadDir(dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() && !ignoredDirs[e.Name()] && !strings.HasPrefix(e.Name(), ".") {
			names = append(names, e.Name())
		}
	}
	return names
}

// classifyDir returns the workspace type + accent for a directory based on its
// marker files, or ok=false if it contains no recognized marker.
func classifyDir(fsys filesystem.FileSystem, dir string) (WorkspaceType, string, bool) {
	entries, err := fsys.ReadDir(dir)
	if err != nil {
		return "", "", false
	}
	names := make(map[string]bool, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			names[e.Name()] = true
		}
	}
	for _, rule := range markerRules {
		for _, f := range rule.files {
			if names[f] {
				if f == "package.json" && packageHasFrontendDependency(fsys, filepath.Join(dir, f)) {
					return TypeFrontend, "frontend", true
				}
				return rule.typ, rule.accent, true
			}
		}
		if rule.suffix != "" {
			for n := range names {
				if strings.HasSuffix(n, rule.suffix) {
					return rule.typ, rule.accent, true
				}
			}
		}
	}
	return "", "", false
}

func packageHasFrontendDependency(fsys filesystem.FileSystem, manifestPath string) bool {
	data, err := fsys.ReadFile(manifestPath)
	if err != nil {
		return false
	}
	var manifest map[string]json.RawMessage
	if json.Unmarshal(data, &manifest) != nil {
		return false
	}
	for _, field := range []string{"dependencies", "devDependencies"} {
		var dependencies map[string]json.RawMessage
		if json.Unmarshal(manifest[field], &dependencies) != nil {
			continue
		}
		for name := range dependencies {
			if frontendDependencies[name] {
				return true
			}
		}
	}
	return false
}

// typeLabel is the human-facing label for a workspace type.
func typeLabel(t WorkspaceType) string {
	switch t {
	case TypeProject:
		return "Project"
	case TypeFrontend:
		return "Frontend"
	case TypeNode:
		return "Node"
	case TypeGo:
		return "Go"
	case TypePython:
		return "Python"
	case TypeDocker:
		return "Docker"
	case TypeTerraform:
		return "Terraform"
	default:
		return "General"
	}
}
