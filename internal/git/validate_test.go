package git

import (
	"context"
	"strings"
	"testing"
)

func TestService_Stage_RejectsInvalidPaths(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)
	svc := NewService()

	tests := []struct {
		name  string
		paths []string
	}{
		{"empty list", nil},
		{"empty path", []string{""}},
		{"absolute path", []string{"/etc/passwd"}},
		{"parent traversal", []string{"../outside.txt"}},
		{"embedded traversal", []string{"src/../../outside.txt"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := svc.Stage(context.Background(), dir, tt.paths); err == nil {
				t.Errorf("Stage(%v) error = nil, want validation error", tt.paths)
			}
		})
	}
}

func TestService_Unstage_RejectsInvalidPaths(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)
	svc := NewService()

	if err := svc.Unstage(context.Background(), dir, []string{"../x"}); err == nil {
		t.Error("Unstage(../x) error = nil, want validation error")
	}
}

func TestService_FileAtRev_RejectsInvalidInput(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)
	svc := NewService()

	if _, err := svc.FileAtRev(context.Background(), dir, "HEAD", "../secret"); err == nil {
		t.Error("FileAtRev with traversal path: error = nil, want validation error")
	}
	if _, err := svc.FileAtRev(context.Background(), dir, "main~1", "README.md"); err == nil {
		t.Error("FileAtRev with non-whitelisted rev: error = nil, want validation error")
	}
	if _, err := svc.FileAtRev(context.Background(), dir, "HEAD", "README.md"); err != nil {
		t.Errorf("FileAtRev(HEAD, README.md) error = %v, want nil", err)
	}
}

func TestService_Stage_DotDotInFilenameAllowed(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)
	writeFile(t, dir, "weird..name.txt", "x\n")
	svc := NewService()

	// ".." as a path SEGMENT is traversal; ".." inside a filename is legal.
	if err := svc.Stage(context.Background(), dir, []string{"weird..name.txt"}); err != nil {
		t.Errorf("Stage(weird..name.txt) error = %v, want nil", err)
	}
}

func TestService_Stage_TreatsPathspecMagicLiterally(t *testing.T) {
	requireGit(t)
	const name = "f[x].txt"
	dir := makeConflictNamed(t, name)
	writeFile(t, dir, name, "resolved\n")
	writeFile(t, dir, "fx.txt", "unrelated\n")
	svc := NewService()

	if err := svc.Stage(context.Background(), dir, []string{name}); err != nil {
		t.Fatalf("Stage(%s) error = %v", name, err)
	}

	if isUnmerged(t, dir, name) {
		t.Fatalf("%q remains unmerged; Stage treated its name as pathspec magic", name)
	}
	if got := strings.TrimSpace(gitCmd(t, dir, "status", "--porcelain", "--", "fx.txt")); got != "?? fx.txt" {
		t.Fatalf("unrelated path status = %q, want it left untracked", got)
	}
}

func TestValidateRepoRelPaths_ErrorNamesOffender(t *testing.T) {
	err := validateRepoRelPaths([]string{"ok.txt", "/abs/path"})
	if err == nil || !strings.Contains(err.Error(), "/abs/path") {
		t.Errorf("error = %v, want offending path named", err)
	}
}
