package runprofile

import (
	"encoding/json"
	"errors"
	"testing"
)

// RecordRun writes run recency to the sidecar, NOT to run-profiles.json, so
// stamping a run never rewrites profile definitions.
func TestStoreRecordRunWritesSidecarNotProfiles(t *testing.T) {
	mockFS, files := newMockFSWithFiles()
	store := NewStore(mockFS, "/workspace")
	if err := store.Save(RunProfile{ID: "p1", Name: "Build", Type: ProfileTypeSingle, Source: ProfileSourceUser, Command: "make"}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	profilesPath := "/workspace/" + profilesFileName
	before := string(files[profilesPath])

	if err := store.RecordRun("p1", 4242); err != nil {
		t.Fatalf("RecordRun: %v", err)
	}

	// Profiles file is untouched by the run.
	if after := string(files[profilesPath]); after != before {
		t.Errorf("RecordRun must not rewrite the profiles file\nbefore: %s\nafter:  %s", before, after)
	}
	// Recency landed in the sidecar.
	var rf RecencyFile
	if err := json.Unmarshal(files["/workspace/"+recencyFileName], &rf); err != nil {
		t.Fatalf("unmarshal sidecar: %v", err)
	}
	if rf.Version != recencyFileVersion || rf.Recency["p1"] != 4242 {
		t.Errorf("sidecar = %+v, want version %d recency[p1]=4242", rf, recencyFileVersion)
	}
}

// Same-profile launches can complete their asynchronous recency persistence in
// the opposite order from admission. LastRunAt is a launch-recency value, so an
// older completion must never overwrite the timestamp captured for a newer
// admitted run.
func TestStoreRecordRunDoesNotRegressLaunchRecencyOnReverseCompletion(t *testing.T) {
	mockFS, files := newMockFSWithFiles()
	store := NewStore(mockFS, "/workspace")
	const (
		profileID = "parallel"
		olderTS   = int64(100)
		newerTS   = int64(200)
	)

	// Admissions were ordered olderTS then newerTS, but the newer run reaches
	// RecordRun first and the older run completes second.
	if err := store.RecordRun(profileID, newerTS); err != nil {
		t.Fatalf("RecordRun(newer): %v", err)
	}
	if err := store.RecordRun(profileID, olderTS); err != nil {
		t.Fatalf("RecordRun(older): %v", err)
	}
	if got := store.GetState()[profileID].LastRunAt; got != newerTS {
		t.Fatalf("in-memory LastRunAt = %d, want newer admitted timestamp %d", got, newerTS)
	}

	var persisted RecencyFile
	if err := json.Unmarshal(files["/workspace/"+recencyFileName], &persisted); err != nil {
		t.Fatalf("unmarshal recency sidecar: %v", err)
	}
	if got := persisted.Recency[profileID]; got != newerTS {
		t.Fatalf("persisted LastRunAt = %d, want newer admitted timestamp %d", got, newerTS)
	}
}

// RecordRun is synchronous: a failed sidecar write surfaces the error to the
// caller and rolls the in-memory timestamp back.
func TestStoreRecordRunSurfacesAndRollsBackOnFailure(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, "/workspace")
	if _, err := store.Load(); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordRun("p1", 111); err != nil {
		t.Fatalf("first RecordRun: %v", err)
	}

	errDisk := errors.New("disk full")
	mockFS.RenameFunc = func(o, n string) error { return errDisk }

	err := store.RecordRun("p1", 222)
	if !errors.Is(err, errDisk) {
		t.Fatalf("expected RecordRun to surface the write error, got %v", err)
	}
	if got := store.GetState()["p1"].LastRunAt; got != 111 {
		t.Errorf("failed RecordRun must roll back; lastRunAt = %d, want 111", got)
	}
}

// Run recency survives a reload via the sidecar.
func TestStoreRecencyRoundTripsViaSidecar(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, "/workspace")
	if _, err := store.Load(); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordRun("p1", 999); err != nil {
		t.Fatalf("RecordRun: %v", err)
	}

	reloaded := NewStore(mockFS, "/workspace")
	if _, err := reloaded.Load(); err != nil {
		t.Fatal(err)
	}
	if got := reloaded.GetState()["p1"].LastRunAt; got != 999 {
		t.Errorf("recency lost across reload: got %d, want 999", got)
	}
}

// A pre-split v3 file that embedded recency in profileState is migrated into the
// sidecar on load, and the recency survives.
func TestStoreLoadMigratesLegacyRecencyToSidecar(t *testing.T) {
	mockFS, files := newMockFSWithFiles()
	legacy := ProfilesFile{
		Version:  profilesFileVersion,
		Profiles: []RunProfile{{ID: "p1", Name: "Build", Type: ProfileTypeSingle, Source: ProfileSourceUser, Command: "make"}},
		ProfileState: map[string]ProfileUIState{
			"p1": {Adopted: true, LastRunAt: 555}, // recency embedded the old way
		},
	}
	data, _ := json.Marshal(legacy)
	_ = mockFS.WriteFile("/workspace/"+profilesFileName, data, 0o644)

	store := NewStore(mockFS, "/workspace")
	if _, err := store.Load(); err != nil {
		t.Fatal(err)
	}

	// In-memory state still carries the migrated recency + adoption.
	st := store.GetState()["p1"]
	if !st.Adopted || st.LastRunAt != 555 {
		t.Errorf("migrated state = %+v, want adopted=true lastRunAt=555", st)
	}
	// The sidecar was written during load.
	var rf RecencyFile
	if err := json.Unmarshal(files["/workspace/"+recencyFileName], &rf); err != nil {
		t.Fatalf("expected sidecar written on migration: %v", err)
	}
	if rf.Recency["p1"] != 555 {
		t.Errorf("migrated sidecar[p1] = %d, want 555", rf.Recency["p1"])
	}
}

// PruneState drops recency-only entries whose ID is no longer valid, but keeps
// adopted entries (so a workspace's working set survives temporary branch churn
// where a detected profile briefly disappears).
func TestStorePruneStateDropsStaleRecencyKeepsAdopted(t *testing.T) {
	mockFS := newMockFS()
	pf := ProfilesFile{
		Version:  profilesFileVersion,
		Profiles: []RunProfile{{ID: "saved1", Name: "Build", Type: ProfileTypeSingle, Source: ProfileSourceUser, Command: "make"}},
		ProfileState: map[string]ProfileUIState{
			"saved1":       {LastRunAt: 100},                // valid (saved) -> keep
			"detected1":    {LastRunAt: 200},                // valid (detected) -> keep
			"ghostRecency": {LastRunAt: 300},                // stale recency-only -> drop
			"ghostAdopted": {Adopted: true},                 // gone but adopted -> keep
			"ghostBoth":    {Adopted: true, LastRunAt: 400}, // gone but adopted -> keep
		},
	}
	data, _ := json.Marshal(pf)
	_ = mockFS.WriteFile("/workspace/"+profilesFileName, data, 0o644)

	store := NewStore(mockFS, "/workspace")
	if _, err := store.Load(); err != nil {
		t.Fatal(err)
	}

	valid := map[string]bool{"saved1": true, "detected1": true}
	if err := store.PruneState(valid); err != nil {
		t.Fatalf("PruneState: %v", err)
	}

	st := store.GetState()
	if _, ok := st["ghostRecency"]; ok {
		t.Errorf("stale recency-only entry should be pruned, still present: %+v", st["ghostRecency"])
	}
	for _, keep := range []string{"saved1", "detected1", "ghostAdopted", "ghostBoth"} {
		if _, ok := st[keep]; !ok {
			t.Errorf("entry %q should be preserved, was pruned", keep)
		}
	}

	// The prune is persisted: a fresh store sees the cleaned recency, and the
	// stale entry does not resurface from any legacy profiles-file recency.
	reloaded := NewStore(mockFS, "/workspace")
	if _, err := reloaded.Load(); err != nil {
		t.Fatal(err)
	}
	rst := reloaded.GetState()
	if _, ok := rst["ghostRecency"]; ok {
		t.Errorf("prune must persist; ghostRecency reappeared after reload")
	}
	if got := rst["ghostBoth"].LastRunAt; got != 400 {
		t.Errorf("adopted+recency entry should round-trip; ghostBoth lastRunAt=%d, want 400", got)
	}
}

// A prune that changes nothing must not rewrite anything.
func TestStorePruneStateNoopDoesNotPersist(t *testing.T) {
	mockFS, _ := newMockFSWithFiles()
	pf := ProfilesFile{
		Version:      profilesFileVersion,
		Profiles:     []RunProfile{{ID: "saved1", Name: "Build", Type: ProfileTypeSingle, Source: ProfileSourceUser, Command: "make"}},
		ProfileState: map[string]ProfileUIState{"saved1": {LastRunAt: 100}},
	}
	data, _ := json.Marshal(pf)
	_ = mockFS.WriteFile("/workspace/"+profilesFileName, data, 0o644)

	store := NewStore(mockFS, "/workspace")
	if _, err := store.Load(); err != nil {
		t.Fatal(err)
	}

	renames := 0
	base := mockFS.RenameFunc
	mockFS.RenameFunc = func(o, n string) error {
		renames++
		return base(o, n)
	}

	if err := store.PruneState(map[string]bool{"saved1": true}); err != nil {
		t.Fatalf("PruneState: %v", err)
	}
	if renames != 0 {
		t.Fatalf("no-op prune must not write, got %d writes", renames)
	}
}

// ProjectRunProfileManager.Load wires pruning across every workspace store:
// a stale recency-only entry on disk is gone after a load, while saved and
// adopted entries survive.
func TestProjectManagerLoadPrunesStaleRecency(t *testing.T) {
	files := map[string][]byte{
		"/repo/go.mod": []byte("module example\ngo 1.21\n"),
	}
	savedPF := ProfilesFile{
		Version:  profilesFileVersion,
		Profiles: []RunProfile{{ID: "saved1", Name: "Build", Type: ProfileTypeSingle, Source: ProfileSourceUser, Command: "make"}},
		ProfileState: map[string]ProfileUIState{
			"saved1":       {LastRunAt: 100},
			"ghostRecency": {LastRunAt: 300},
			"ghostAdopted": {Adopted: true},
		},
	}
	data, _ := json.Marshal(savedPF)
	files["/repo/.firn/run-profiles.json"] = data

	mockFS := newProjectTestFS(files)
	m := NewProjectManager(mockFS, "/repo")
	if err := m.Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}

	state := m.Snapshot().ProfileState
	if _, ok := state["ghostRecency"]; ok {
		t.Errorf("stale recency-only entry should be pruned on Load, still present")
	}
	if _, ok := state["saved1"]; !ok {
		t.Errorf("saved profile recency should survive prune-on-Load")
	}
	if _, ok := state["ghostAdopted"]; !ok {
		t.Errorf("adopted entry should survive prune-on-Load through branch churn")
	}
}
