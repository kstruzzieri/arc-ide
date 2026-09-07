package runprofile

import (
	"encoding/json"
	"errors"
	"firn/internal/filesystem"
	"io/fs"
	"reflect"
	"strings"
	"testing"
)

func newMockFS() *filesystem.Mock {
	m, _ := newMockFSWithFiles()
	return m
}

// newMockFSWithFiles is like newMockFS but also returns the backing file map so
// tests can assert on what was actually written to disk (e.g. that the atomic
// temp+rename persist left no stray .tmp file behind).
func newMockFSWithFiles() (*filesystem.Mock, map[string][]byte) {
	files := map[string][]byte{}
	dirs := map[string]bool{}

	m := &filesystem.Mock{
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
		MkdirAllFunc: func(path string, perm fs.FileMode) error {
			dirs[path] = true
			return nil
		},
		RenameFunc: func(oldpath, newpath string) error {
			data, ok := files[oldpath]
			if !ok {
				return fs.ErrNotExist
			}
			files[newpath] = data
			delete(files, oldpath)
			return nil
		},
	}
	return m, files
}

func TestStoreSaveRollsBackOnPersistError(t *testing.T) {
	mockFS, _ := newMockFSWithFiles()
	store := NewStore(mockFS, "/workspace")

	mockFS.WriteFileFunc = func(string, []byte, fs.FileMode) error {
		return errors.New("disk full")
	}

	err := store.Save(RunProfile{ID: "p1", Name: "Dev", Type: ProfileTypeSingle, Command: "x"})
	if err == nil {
		t.Fatal("expected Save to return an error when persist fails")
	}
	if store.Contains("p1") {
		t.Fatal("Save must not leave a profile in memory when the disk write fails")
	}
	if got := store.GetAll(); len(got) != 0 {
		t.Fatalf("expected empty store after a failed save, got %d profiles", len(got))
	}
}

func TestStoreSaveRollsBackUpdateOnPersistError(t *testing.T) {
	mockFS, _ := newMockFSWithFiles()
	store := NewStore(mockFS, "/workspace")
	if err := store.Save(RunProfile{ID: "p1", Name: "Old", Type: ProfileTypeSingle, Command: "x"}); err != nil {
		t.Fatalf("seed save: %v", err)
	}

	mockFS.WriteFileFunc = func(string, []byte, fs.FileMode) error {
		return errors.New("disk full")
	}

	err := store.Save(RunProfile{ID: "p1", Name: "New", Type: ProfileTypeSingle, Command: "y"})
	if err == nil {
		t.Fatal("expected error when persisting an update fails")
	}
	got := store.GetAll()
	if len(got) != 1 || got[0].Name != "Old" || got[0].Command != "x" {
		t.Fatalf("a failed update must restore the prior value, got %+v", got)
	}
}

func TestStoreDeleteRollsBackOnPersistError(t *testing.T) {
	mockFS, _ := newMockFSWithFiles()
	store := NewStore(mockFS, "/workspace")
	if err := store.Save(RunProfile{ID: "p1", Name: "Dev", Type: ProfileTypeSingle, Command: "x"}); err != nil {
		t.Fatalf("seed save: %v", err)
	}

	mockFS.WriteFileFunc = func(string, []byte, fs.FileMode) error {
		return errors.New("disk full")
	}

	err := store.Delete("p1")
	if err == nil {
		t.Fatal("expected Delete to return an error when persist fails")
	}
	if !store.Contains("p1") {
		t.Fatal("Delete must keep the profile in memory when the disk write fails")
	}
}

func TestStoreLoadNoFile(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, "/workspace")

	profiles, err := store.Load()
	if err != nil {
		t.Fatalf("Load() returned error: %v", err)
	}
	if len(profiles) != 0 {
		t.Errorf("expected empty list, got %d profiles", len(profiles))
	}
}

func TestStoreLoadUnsupportedVersion(t *testing.T) {
	mockFS := newMockFS()
	pf := ProfilesFile{
		Version:  99,
		Profiles: []RunProfile{},
	}
	data, _ := json.Marshal(pf)
	_ = mockFS.WriteFile("/workspace/.firn/run-profiles.json", data, 0o644)

	store := NewStore(mockFS, "/workspace")
	_, err := store.Load()
	if err == nil {
		t.Fatal("expected error for unsupported version")
	}
	if !strings.Contains(err.Error(), "unsupported profiles file version") {
		t.Errorf("expected version error, got: %v", err)
	}
}

func TestStoreLoadValidFile(t *testing.T) {
	mockFS := newMockFS()
	pf := ProfilesFile{
		Version: 1,
		Profiles: []RunProfile{
			{ID: "p1", Name: "Build", Type: ProfileTypeSingle, Source: ProfileSourceUser, Command: "make build"},
		},
	}
	data, _ := json.Marshal(pf)
	// Pre-populate test data through the mock's WriteFile method
	_ = mockFS.WriteFile("/workspace/.firn/run-profiles.json", data, 0o644)

	store := NewStore(mockFS, "/workspace")
	profiles, err := store.Load()
	if err != nil {
		t.Fatalf("Load() returned error: %v", err)
	}
	if len(profiles) != 1 {
		t.Fatalf("expected 1 profile, got %d", len(profiles))
	}
	if profiles[0].ID != "p1" {
		t.Errorf("expected ID 'p1', got %q", profiles[0].ID)
	}
}

func TestStoreSaveCreatesNewProfile(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, "/workspace")

	profile := RunProfile{
		ID:      "p1",
		Name:    "Build",
		Type:    ProfileTypeSingle,
		Source:  ProfileSourceUser,
		Command: "make build",
	}
	if err := store.Save(profile); err != nil {
		t.Fatalf("Save() returned error: %v", err)
	}

	all := store.GetAll()
	if len(all) != 1 {
		t.Fatalf("expected 1 profile, got %d", len(all))
	}
	if all[0].Name != "Build" {
		t.Errorf("expected name 'Build', got %q", all[0].Name)
	}
}

func TestStoreSaveUpdatesExisting(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, "/workspace")

	profile := RunProfile{
		ID:      "p1",
		Name:    "Build",
		Type:    ProfileTypeSingle,
		Source:  ProfileSourceUser,
		Command: "make build",
	}
	_ = store.Save(profile)

	profile.Name = "Build (updated)"
	_ = store.Save(profile)

	all := store.GetAll()
	if len(all) != 1 {
		t.Fatalf("expected 1 profile after upsert, got %d", len(all))
	}
	if all[0].Name != "Build (updated)" {
		t.Errorf("expected updated name, got %q", all[0].Name)
	}
}

func TestStoreDelete(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, "/workspace")

	_ = store.Save(RunProfile{ID: "p1", Name: "Build", Type: ProfileTypeSingle, Source: ProfileSourceUser, Command: "make"})
	_ = store.Save(RunProfile{ID: "p2", Name: "Test", Type: ProfileTypeSingle, Source: ProfileSourceUser, Command: "make test"})

	if err := store.Delete("p1"); err != nil {
		t.Fatalf("Delete() returned error: %v", err)
	}

	all := store.GetAll()
	if len(all) != 1 {
		t.Fatalf("expected 1 profile after delete, got %d", len(all))
	}
	if all[0].ID != "p2" {
		t.Errorf("expected remaining profile 'p2', got %q", all[0].ID)
	}
}

func TestStoreDeleteNotFound(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, "/workspace")

	err := store.Delete("nonexistent")
	if err == nil {
		t.Fatal("expected error for deleting nonexistent profile")
	}
}

func TestStorePin(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, "/workspace")

	detected := RunProfile{
		ID:           "detected-pkg-build",
		Name:         "npm run build",
		Type:         ProfileTypeSingle,
		Source:       ProfileSourceDetected,
		Command:      "npm run build",
		DetectedFrom: "package.json",
	}

	if err := store.Pin(detected); err != nil {
		t.Fatalf("Pin() returned error: %v", err)
	}

	all := store.GetAll()
	if len(all) != 1 {
		t.Fatalf("expected 1 profile, got %d", len(all))
	}
	if all[0].Source != ProfileSourceUser {
		t.Errorf("expected source 'user' after pin, got %q", all[0].Source)
	}
	if all[0].DetectedFrom != "" {
		t.Errorf("expected DetectedFrom cleared after pin, got %q", all[0].DetectedFrom)
	}
}

func TestStoreGetAllReturnsCopy(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, "/workspace")

	_ = store.Save(RunProfile{ID: "p1", Name: "Build", Type: ProfileTypeSingle, Source: ProfileSourceUser, Command: "make"})

	all := store.GetAll()
	all[0].Name = "mutated"

	// Verify internal state is not affected
	internal := store.GetAll()
	if internal[0].Name != "Build" {
		t.Errorf("GetAll() should return a copy; internal was mutated to %q", internal[0].Name)
	}
}

func TestStoreSetAdoptedToggles(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, "/workspace")
	if _, err := store.Load(); err != nil {
		t.Fatal(err)
	}

	// Set adopted true and verify
	if err := store.SetAdopted("detected-a", true); err != nil {
		t.Fatalf("SetAdopted(true): %v", err)
	}
	st := store.GetState()
	if !st["detected-a"].Adopted {
		t.Errorf("expected adopted=true after SetAdopted(true), got %+v", st)
	}

	// Set adopted false and verify (no lastRunAt so entry should be dropped)
	if err := store.SetAdopted("detected-a", false); err != nil {
		t.Fatalf("SetAdopted(false): %v", err)
	}
	st = store.GetState()
	if entry, ok := st["detected-a"]; ok {
		t.Errorf("expected entry removed when unadopted with no recency, got %+v", entry)
	}
}

func TestStoreSetAdoptedRollsBackOnPersistFailure(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, "/workspace")
	if _, err := store.Load(); err != nil {
		t.Fatal(err)
	}

	persistErr := errors.New("disk full")
	mockFS.RenameFunc = func(oldpath, newpath string) error {
		return persistErr
	}

	err := store.SetAdopted("detected-a", true)
	if !errors.Is(err, persistErr) {
		t.Fatalf("SetAdopted error = %v, want %v", err, persistErr)
	}
	if entry, ok := store.GetState()["detected-a"]; ok {
		t.Fatalf("failed adopt must not remain in memory, got %+v", entry)
	}
}

func TestStoreSetAdoptedFailurePreservesPreviousState(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, "/workspace")
	if _, err := store.Load(); err != nil {
		t.Fatal(err)
	}
	if err := store.SetAdopted("detected-a", true); err != nil {
		t.Fatalf("initial SetAdopted: %v", err)
	}

	persistErr := errors.New("read-only workspace")
	mockFS.RenameFunc = func(oldpath, newpath string) error {
		return persistErr
	}

	err := store.SetAdopted("detected-a", false)
	if !errors.Is(err, persistErr) {
		t.Fatalf("SetAdopted error = %v, want %v", err, persistErr)
	}
	st := store.GetState()["detected-a"]
	if !st.Adopted {
		t.Fatalf("failed unadopt must preserve previous adopted state, got %+v", st)
	}
}

func TestStoreRecordRunPreservesAdopted(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, "/workspace")
	if _, err := store.Load(); err != nil {
		t.Fatal(err)
	}

	if err := store.SetAdopted("detected-a", true); err != nil {
		t.Fatalf("SetAdopted: %v", err)
	}
	if err := store.RecordRun("detected-a", 999); err != nil {
		t.Fatalf("RecordRun: %v", err)
	}
	st := store.GetState()["detected-a"]
	if !st.Adopted || st.LastRunAt != 999 {
		t.Errorf("expected adopted=true and lastRunAt=999, got %+v", st)
	}
}

func TestStoreRecordRunRollsBackOnPersistFailure(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, "/workspace")
	if _, err := store.Load(); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordRun("detected-a", 111); err != nil {
		t.Fatalf("initial RecordRun: %v", err)
	}

	persistErr := errors.New("rename failed")
	mockFS.RenameFunc = func(oldpath, newpath string) error {
		return persistErr
	}

	err := store.RecordRun("detected-a", 222)
	if !errors.Is(err, persistErr) {
		t.Fatalf("RecordRun error = %v, want %v", err, persistErr)
	}
	st := store.GetState()["detected-a"]
	if st.LastRunAt != 111 {
		t.Fatalf("failed RecordRun must preserve previous lastRunAt, got %+v", st)
	}
}

func TestStoreGetStateReturnsCopy(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, "/workspace")
	if _, err := store.Load(); err != nil {
		t.Fatal(err)
	}

	if err := store.SetAdopted("detected-a", true); err != nil {
		t.Fatalf("SetAdopted: %v", err)
	}

	// Mutate returned map
	got := store.GetState()
	got["detected-a"] = ProfileUIState{Adopted: false, LastRunAt: 12345}

	// Internal state must be unchanged
	internal := store.GetState()
	if !internal["detected-a"].Adopted || internal["detected-a"].LastRunAt != 0 {
		t.Errorf("GetState must return a copy; internal was mutated: %+v", internal["detected-a"])
	}
}

func TestStoreGetAllReturnsCopyDeepFields(t *testing.T) {
	mockFS := newMockFS()
	store := NewStore(mockFS, "/workspace")

	_ = store.Save(RunProfile{
		ID:      "p1",
		Name:    "Build",
		Type:    ProfileTypeSingle,
		Source:  ProfileSourceUser,
		Command: "make",
		Env:     map[string]string{"KEY": "original"},
		Tags:    []ProfileTag{TagBuild},
		Steps:   []string{"step1"},
	})

	all := store.GetAll()

	// Mutate the returned map
	all[0].Env["KEY"] = "mutated"
	all[0].Tags[0] = TagTest
	all[0].Steps[0] = "mutated-step"

	// Verify internal state is not affected
	internal := store.GetAll()
	if internal[0].Env["KEY"] != "original" {
		t.Errorf("GetAll() Env should be a deep copy; internal was mutated to %q", internal[0].Env["KEY"])
	}
	if internal[0].Tags[0] != TagBuild {
		t.Errorf("GetAll() Tags should be a deep copy; internal was mutated to %q", internal[0].Tags[0])
	}
	if internal[0].Steps[0] != "step1" {
		t.Errorf("GetAll() Steps should be a deep copy; internal was mutated to %q", internal[0].Steps[0])
	}
}

func assertNoUnhandledProfileReferenceKinds(t *testing.T, path string, typ reflect.Type) {
	t.Helper()

	switch typ.Kind() {
	case reflect.Struct:
		for i := 0; i < typ.NumField(); i++ {
			field := typ.Field(i)
			assertNoUnhandledProfileReferenceKinds(t, path+"."+field.Name, field.Type)
		}
	case reflect.Array:
		assertNoUnhandledProfileReferenceKinds(t, path+"[]", typ.Elem())
	case reflect.Map, reflect.Slice, reflect.Pointer, reflect.Interface, reflect.Chan, reflect.Func, reflect.UnsafePointer:
		t.Fatalf("%s contains unhandled reference kind %s", path, typ.Kind())
	}
}

func TestDeepCopyProfileCoversAllReferenceFields(t *testing.T) {
	original := RunProfile{
		Env:         map[string]string{"KEY": "original"},
		EnvVariants: EnvVariants{{Name: "dev", EnvFile: ".env.dev"}},
		Tags:        []ProfileTag{TagBuild},
		Steps:       []string{"step1"},
	}
	copied := deepCopyProfile(original)
	if !reflect.DeepEqual(original, copied) {
		t.Fatalf("deepCopyProfile changed values:\noriginal=%#v\ncopied=%#v", original, copied)
	}
	originalValue := reflect.ValueOf(original)
	copiedValue := reflect.ValueOf(copied)

	for i := 0; i < originalValue.NumField(); i++ {
		field := originalValue.Field(i)
		fieldType := originalValue.Type().Field(i)
		path := "RunProfile." + fieldType.Name
		switch field.Kind() {
		case reflect.Map, reflect.Slice, reflect.Pointer:
			if field.IsNil() {
				t.Fatalf("%s is a new reference field; add it to this fixture", path)
			}
			if field.Pointer() == copiedValue.Field(i).Pointer() {
				t.Errorf("deepCopyProfile aliases %s", path)
			}
			if field.Kind() == reflect.Map {
				assertNoUnhandledProfileReferenceKinds(t, path+" key", fieldType.Type.Key())
				assertNoUnhandledProfileReferenceKinds(t, path+" value", fieldType.Type.Elem())
			} else {
				assertNoUnhandledProfileReferenceKinds(t, path+" element", fieldType.Type.Elem())
			}
		case reflect.Struct, reflect.Array:
			assertNoUnhandledProfileReferenceKinds(t, path, fieldType.Type)
		case reflect.Interface, reflect.Chan, reflect.Func, reflect.UnsafePointer:
			t.Fatalf("%s added unsupported mutable kind %s", path, field.Kind())
		}
	}

	original.Env["KEY"] = "mutated"
	original.EnvVariants[0].Name = "mutated"
	original.Tags[0] = TagTest
	original.Steps[0] = "mutated"

	if copied.Env["KEY"] != "original" ||
		copied.EnvVariants[0].Name != "dev" ||
		copied.Tags[0] != TagBuild ||
		copied.Steps[0] != "step1" {
		t.Fatalf("deepCopyProfile retained caller-owned reference data: %#v", copied)
	}
}

func TestStorePersistIsAtomic(t *testing.T) {
	mockFS, files := newMockFSWithFiles()
	store := NewStore(mockFS, "/workspace")
	if _, err := store.Load(); err != nil {
		t.Fatal(err)
	}

	profilesPath := "/workspace/" + profilesFileName
	recencyPath := "/workspace/" + recencyFileName

	// Adoption persists to the profiles file; recency to the sidecar.
	if err := store.SetAdopted("detected-a", true); err != nil {
		t.Fatalf("SetAdopted: %v", err)
	}
	if err := store.RecordRun("detected-a", 4242); err != nil {
		t.Fatalf("RecordRun: %v", err)
	}

	// Both files exist with no stray temp files (atomic rename moved them).
	for _, p := range []string{profilesPath, recencyPath} {
		if _, ok := files[p]; !ok {
			t.Fatalf("expected file at %q after persist", p)
		}
		if _, ok := files[p+".tmp"]; ok {
			t.Errorf("expected temp file %q.tmp to be gone after atomic rename", p)
		}
	}

	// Profiles file carries adoption only — never recency.
	var pf ProfilesFile
	if err := json.Unmarshal(files[profilesPath], &pf); err != nil {
		t.Fatalf("unmarshal profiles file: %v", err)
	}
	if pf.Version != profilesFileVersion {
		t.Errorf("expected version %d, got %d", profilesFileVersion, pf.Version)
	}
	if st, ok := pf.ProfileState["detected-a"]; !ok || !st.Adopted {
		t.Errorf("expected adopted entry in profiles file, got %+v", pf.ProfileState)
	} else if st.LastRunAt != 0 {
		t.Errorf("profiles file must not carry recency, got lastRunAt=%d", st.LastRunAt)
	}

	// Recency sidecar carries the timestamp.
	var rf RecencyFile
	if err := json.Unmarshal(files[recencyPath], &rf); err != nil {
		t.Fatalf("unmarshal recency sidecar: %v", err)
	}
	if rf.Recency["detected-a"] != 4242 {
		t.Errorf("expected recency 4242 in sidecar, got %+v", rf.Recency)
	}

	// A fresh store merges both files back into the combined state.
	reloaded := NewStore(mockFS, "/workspace")
	if _, err := reloaded.Load(); err != nil {
		t.Fatalf("reload Load: %v", err)
	}
	got := reloaded.GetState()["detected-a"]
	if !got.Adopted || got.LastRunAt != 4242 {
		t.Errorf("reloaded state mismatch: %+v", got)
	}
}
