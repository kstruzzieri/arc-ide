package ai

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"firn/internal/filesystem"
	"github.com/kstruzzieri/go-llm/provider"
)

func remoteDestination(providerName, endpoint string) ProviderDestination {
	return ProviderDestination{
		Provider:       providerName,
		Model:          "m",
		Endpoint:       endpoint,
		Classification: "remote",
		Digest:         digestOf(providerName, endpoint),
	}
}

func consentPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "consent", "grants.json")
}

func seedConsentFile(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
}

func grantRecordJSON(providerName, endpoint string) string {
	return fmt.Sprintf(`{"digest": %q, "provider": %q, "endpoint": %q, "grantedAt": "2026-08-07T00:00:00Z"}`,
		digestOf(providerName, endpoint), providerName, endpoint)
}

func TestConsentStoreGrantPersistsDurably(t *testing.T) {
	path := consentPath(t)
	fsys := filesystem.NewOS()

	store, err := OpenConsentStore(fsys, path)
	if err != nil {
		t.Fatalf("OpenConsentStore on a missing file: %v", err)
	}
	dest := remoteDestination("remote", "https://api.example.com/v1")
	if store.Has(dest.Digest) {
		t.Fatal("Has reported a grant before any was made")
	}
	if err := store.Grant(dest); err != nil {
		t.Fatalf("Grant: %v", err)
	}
	if !store.Has(dest.Digest) {
		t.Fatal("Has = false immediately after Grant")
	}

	if runtime.GOOS != "windows" {
		dirInfo, err := os.Lstat(filepath.Dir(path))
		if err != nil {
			t.Fatalf("Lstat dir: %v", err)
		}
		if dirInfo.Mode().Perm() != 0o700 {
			t.Fatalf("consent dir mode = %o, want 0700", dirInfo.Mode().Perm())
		}
		fileInfo, err := os.Lstat(path)
		if err != nil {
			t.Fatalf("Lstat file: %v", err)
		}
		if fileInfo.Mode().Perm() != 0o600 {
			t.Fatalf("consent file mode = %o, want 0600", fileInfo.Mode().Perm())
		}
	}

	// Duplicate grant is idempotent.
	if err := store.Grant(dest); err != nil {
		t.Fatalf("duplicate Grant: %v", err)
	}

	reopened, err := OpenConsentStore(fsys, path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if !reopened.Has(dest.Digest) {
		t.Fatal("reopened store lost the grant")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if got := strings.Count(string(data), dest.Digest); got != 1 {
		t.Fatalf("persisted %d records for one destination, want 1: %s", got, data)
	}
}

func TestConsentStoreFailsClosedOnInvalidContent(t *testing.T) {
	remoteEndpoint := "https://api.example.com/v1"
	valid := grantRecordJSON("remote", remoteEndpoint)
	cases := map[string]string{
		"corrupt":         `{not json`,
		"unknown version": `{"version": 2, "grants": []}`,
		"duplicate record": fmt.Sprintf(`{"version": 1, "grants": [%s, %s]}`,
			valid, valid),
		"local endpoint": fmt.Sprintf(`{"version": 1, "grants": [%s]}`,
			grantRecordJSON("ollama", "http://localhost:11434")),
		"noncanonical endpoint": fmt.Sprintf(`{"version": 1, "grants": [%s]}`,
			grantRecordJSON("remote", "https://Api.Example.com/")),
		"digest mismatch": fmt.Sprintf(`{"version": 1, "grants": [{"digest": "deadbeef", "provider": "remote", "endpoint": %q, "grantedAt": "2026-08-07T00:00:00Z"}]}`,
			remoteEndpoint),
		"untrusted extra classification field": fmt.Sprintf(
			`{"version": 1, "grants": [{"digest": %q, "provider": "remote", "endpoint": %q, "grantedAt": "2026-08-07T00:00:00Z", "classification": "local"}]}`,
			digestOf("remote", remoteEndpoint), remoteEndpoint),
		"oversize": fmt.Sprintf(`{"version": 1, "grants": [%s]}`, valid) +
			strings.Repeat(" ", ConsentStoreLimit),
		// F18/D10 legacy-record regression: a record written before dot-segment
		// rejection existed. NormalizeEndpoint now rejects it outright rather
		// than returning a mismatched canonical string, but the store still
		// fails closed the same way. Repair: see the ConsentStore doc comment.
		"legacy record: dot-segment path": fmt.Sprintf(`{"version": 1, "grants": [%s]}`,
			grantRecordJSON("remote", "https://api.example.com/v1/../x")),
		// F18/D10 legacy-record regression: a record written before IP-literal
		// collapse existed, storing the raw (non-collapsed) IPv6 spelling. It
		// is well-formed but no longer canonical, so it fails the same way as
		// "noncanonical endpoint" above. Repair: see the ConsentStore doc comment.
		"legacy record: uncollapsed IPv6 spelling": fmt.Sprintf(`{"version": 1, "grants": [%s]}`,
			grantRecordJSON("remote", "http://[2001:0db8::1]:8080")),
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			path := consentPath(t)
			seedConsentFile(t, path, []byte(content))
			store, err := OpenConsentStore(filesystem.NewOS(), path)
			if !errors.Is(err, ErrConsentUnavailable) {
				t.Fatalf("OpenConsentStore = %v, want ErrConsentUnavailable", err)
			}
			if store.Has(digestOf("remote", remoteEndpoint)) {
				t.Fatal("Has authorized from an invalid store")
			}
			if err := store.Grant(remoteDestination("remote", remoteEndpoint)); !errors.Is(err, ErrConsentUnavailable) {
				t.Fatalf("Grant = %v, want ErrConsentUnavailable", err)
			}
			// F18/D10 carry-forward: every invalid-content case above fails
			// the store closed, so each must also yield the zero destination
			// policy — there is no partial credit for grants that would have
			// parsed under an older canonicalization rule or any other
			// invalid-content case.
			if !store.DestinationPolicy().IsZero() {
				t.Fatal("DestinationPolicy is not zero for a store invalidated by invalid content")
			}
		})
	}
}

func TestConsentStoreFailsClosedOnSymlinkAndNonRegularFiles(t *testing.T) {
	t.Run("symlink", func(t *testing.T) {
		target := filepath.Join(t.TempDir(), "real-grants.json")
		seedConsentFile(t, target, []byte(fmt.Sprintf(`{"version": 1, "grants": [%s]}`,
			grantRecordJSON("remote", "https://api.example.com/v1"))))
		path := consentPath(t)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatalf("MkdirAll: %v", err)
		}
		if err := os.Symlink(target, path); err != nil {
			t.Skipf("symlinks unsupported here: %v", err)
		}
		store, err := OpenConsentStore(filesystem.NewOS(), path)
		if !errors.Is(err, ErrConsentUnavailable) {
			t.Fatalf("OpenConsentStore = %v, want ErrConsentUnavailable", err)
		}
		if store.Has(digestOf("remote", "https://api.example.com/v1")) {
			t.Fatal("Has authorized through a symlinked store")
		}
	})
	t.Run("directory", func(t *testing.T) {
		path := consentPath(t)
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatalf("MkdirAll: %v", err)
		}
		if _, err := OpenConsentStore(filesystem.NewOS(), path); !errors.Is(err, ErrConsentUnavailable) {
			t.Fatalf("OpenConsentStore = %v, want ErrConsentUnavailable", err)
		}
	})
}

// chmodNopFS defeats EnsureDirPerm's tightening so a loose parent survives it.
type chmodNopFS struct{ *filesystem.OS }

func (chmodNopFS) Chmod(string, fs.FileMode) error { return nil }

func TestConsentStoreRejectsGroupOrOtherPermissionBits(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not model POSIX permission bits")
	}
	t.Run("file", func(t *testing.T) {
		path := consentPath(t)
		seedConsentFile(t, path, []byte(fmt.Sprintf(`{"version": 1, "grants": [%s]}`,
			grantRecordJSON("remote", "https://api.example.com/v1"))))
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatalf("Chmod: %v", err)
		}
		store, err := OpenConsentStore(filesystem.NewOS(), path)
		if !errors.Is(err, ErrConsentUnavailable) {
			t.Fatalf("OpenConsentStore = %v, want ErrConsentUnavailable", err)
		}
		if store.Has(digestOf("remote", "https://api.example.com/v1")) {
			t.Fatal("Has authorized from a group/other-readable file")
		}
	})
	t.Run("parent", func(t *testing.T) {
		path := consentPath(t)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("MkdirAll: %v", err)
		}
		if _, err := OpenConsentStore(chmodNopFS{filesystem.NewOS()}, path); !errors.Is(err, ErrConsentUnavailable) {
			t.Fatalf("OpenConsentStore = %v, want ErrConsentUnavailable", err)
		}
	})
}

// aiWriteSyncOnlyFS implements only the WriteFileSync half of the durable seam.
type aiWriteSyncOnlyFS struct{ filesystem.FileSystem }

func (aiWriteSyncOnlyFS) WriteFileSync(string, []byte, fs.FileMode) error { return nil }

// aiSyncDirOnlyFS implements only the SyncDir half of the durable seam.
type aiSyncDirOnlyFS struct{ filesystem.FileSystem }

func (aiSyncDirOnlyFS) SyncDir(string) error { return nil }

func TestConsentStoreUnavailableWithoutFullDurability(t *testing.T) {
	for name, wrap := range map[string]func(filesystem.FileSystem) filesystem.FileSystem{
		"write-sync only": func(f filesystem.FileSystem) filesystem.FileSystem { return aiWriteSyncOnlyFS{f} },
		"sync-dir only":   func(f filesystem.FileSystem) filesystem.FileSystem { return aiSyncDirOnlyFS{f} },
	} {
		t.Run(name, func(t *testing.T) {
			path := consentPath(t)
			store, err := OpenConsentStore(wrap(filesystem.NewOS()), path)
			if !errors.Is(err, ErrConsentUnavailable) {
				t.Fatalf("OpenConsentStore = %v, want ErrConsentUnavailable", err)
			}
			dest := remoteDestination("remote", "https://api.example.com/v1")
			if store.Has(dest.Digest) {
				t.Fatal("Has authorized without durability")
			}
			if err := store.Grant(dest); !errors.Is(err, ErrConsentUnavailable) {
				t.Fatalf("Grant = %v, want the stored ErrConsentUnavailable", err)
			}
			if _, err := os.Lstat(path); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("a consent file was written despite unavailability: %v", err)
			}
		})
	}
}

func TestConsentStoreEmptyPathMakesNoFilesystemCalls(t *testing.T) {
	calls := 0
	count := func() { calls++ }
	mock := &filesystem.Mock{
		ReadDirFunc:   func(string) ([]fs.DirEntry, error) { count(); return nil, nil },
		ReadFileFunc:  func(string) ([]byte, error) { count(); return nil, nil },
		WriteFileFunc: func(string, []byte, fs.FileMode) error { count(); return nil },
		StatFunc:      func(string) (fs.FileInfo, error) { count(); return nil, fs.ErrNotExist },
		MkdirAllFunc:  func(string, fs.FileMode) error { count(); return nil },
		RemoveFunc:    func(string) error { count(); return nil },
		RenameFunc:    func(string, string) error { count(); return nil },
	}
	store, err := OpenConsentStore(mock, "")
	if !errors.Is(err, ErrConsentUnavailable) {
		t.Fatalf("OpenConsentStore(\"\") = %v, want ErrConsentUnavailable", err)
	}
	if store.Has("anything") {
		t.Fatal("Has authorized from a pathless store")
	}
	if err := store.Grant(remoteDestination("remote", "https://api.example.com/v1")); !errors.Is(err, ErrConsentUnavailable) {
		t.Fatalf("Grant = %v, want ErrConsentUnavailable", err)
	}
	if calls != 0 {
		t.Fatalf("pathless store made %d filesystem calls, want 0", calls)
	}
}

func TestConsentStoreGrantRejectsInvalidDestinations(t *testing.T) {
	path := consentPath(t)
	store, err := OpenConsentStore(filesystem.NewOS(), path)
	if err != nil {
		t.Fatalf("OpenConsentStore: %v", err)
	}
	cases := map[string]ProviderDestination{
		"local endpoint":        remoteDestination("ollama", "http://localhost:11434"),
		"noncanonical endpoint": remoteDestination("remote", "https://Api.Example.com/"),
		"empty provider":        remoteDestination("", "https://api.example.com"),
		"digest mismatch": {
			Provider:       "remote",
			Model:          "m",
			Endpoint:       "https://api.example.com",
			Classification: "remote",
			Digest:         "deadbeef",
		},
	}
	for name, dest := range cases {
		t.Run(name, func(t *testing.T) {
			if err := store.Grant(dest); err == nil {
				t.Fatal("Grant accepted an invalid destination")
			}
			if store.Has(dest.Digest) {
				t.Fatal("invalid destination became granted")
			}
		})
	}
	if _, err := os.Lstat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("rejected grants still wrote a consent file: %v", err)
	}
}

// renameFailFS is durable but refuses the atomic rename publish step.
type renameFailFS struct {
	*filesystem.OS
	fail bool
}

func (r *renameFailFS) Rename(oldpath, newpath string) error {
	if r.fail {
		return errors.New("rename refused")
	}
	return r.OS.Rename(oldpath, newpath)
}

func TestConsentStoreKeepsPriorGrantsWhenRenameFails(t *testing.T) {
	path := consentPath(t)
	destA := remoteDestination("remote", "https://a.example.com")
	destB := remoteDestination("remote", "https://b.example.com")

	seedStore, err := OpenConsentStore(filesystem.NewOS(), path)
	if err != nil {
		t.Fatalf("OpenConsentStore: %v", err)
	}
	if err := seedStore.Grant(destA); err != nil {
		t.Fatalf("seed Grant: %v", err)
	}

	failing := &renameFailFS{OS: filesystem.NewOS(), fail: true}
	store, err := OpenConsentStore(failing, path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if !store.Has(destA.Digest) {
		t.Fatal("prior grant not loaded")
	}
	if err := store.Grant(destB); err == nil {
		t.Fatal("Grant succeeded despite rename failure")
	}
	if store.Has(destB.Digest) {
		t.Fatal("failed grant mutated the in-memory set")
	}
	if !store.Has(destA.Digest) {
		t.Fatal("failed grant destroyed the prior in-memory set")
	}

	recovered, err := OpenConsentStore(filesystem.NewOS(), path)
	if err != nil {
		t.Fatalf("recovery reopen: %v", err)
	}
	if !recovered.Has(destA.Digest) || recovered.Has(destB.Digest) {
		t.Fatal("on-disk grant set was not left at the prior state")
	}
}

// lstatFailFS is durable and lets the atomic write and rename succeed, but
// fails the post-rename Lstat verification step (persistGrantsLocked, F11c).
type lstatFailFS struct {
	*filesystem.OS
	fail bool
}

func (l *lstatFailFS) Lstat(path string) (fs.FileInfo, error) {
	if l.fail {
		return nil, errors.New("lstat refused")
	}
	return l.OS.Lstat(path)
}

// syncFailpointFS is durable until armed, then fails every directory sync.
type syncFailpointFS struct {
	*filesystem.OS
	failSync bool
}

func (s *syncFailpointFS) SyncDir(path string) error {
	if s.failSync {
		return errors.New("directory sync refused")
	}
	return s.OS.SyncDir(path)
}

func TestConsentStorePostRenameSyncFailureKeepsOldAuthority(t *testing.T) {
	path := consentPath(t)
	destA := remoteDestination("remote", "https://a.example.com")
	destB := remoteDestination("remote", "https://b.example.com")

	fsys := &syncFailpointFS{OS: filesystem.NewOS()}
	store, err := OpenConsentStore(fsys, path)
	if err != nil {
		t.Fatalf("OpenConsentStore: %v", err)
	}
	if err := store.Grant(destA); err != nil {
		t.Fatalf("Grant A: %v", err)
	}

	// Rename publishes B's bytes, but the following directory sync fails.
	fsys.failSync = true
	if err := store.Grant(destB); err == nil {
		t.Fatal("Grant succeeded despite post-rename sync failure")
	}
	if store.Has(destB.Digest) {
		t.Fatal("unsynced grant entered the in-memory authority")
	}
	if !store.Has(destA.Digest) {
		t.Fatal("old in-memory authority was lost")
	}

	// While the parent sync keeps failing, reopening must not authorize anything.
	unavailable, err := OpenConsentStore(fsys, path)
	if !errors.Is(err, ErrConsentUnavailable) {
		t.Fatalf("reopen during sync failure = %v, want ErrConsentUnavailable", err)
	}
	if unavailable.Has(destA.Digest) || unavailable.Has(destB.Digest) {
		t.Fatal("unavailable store authorized a grant")
	}

	// After a successful parent sync, the self-consistent published file loads.
	fsys.failSync = false
	recovered, err := OpenConsentStore(fsys, path)
	if err != nil {
		t.Fatalf("recovery reopen: %v", err)
	}
	if !recovered.Has(destA.Digest) || !recovered.Has(destB.Digest) {
		t.Fatal("self-consistent published grants did not load after recovery")
	}
}

func TestConsentStoreConcurrentGrantAndHas(t *testing.T) {
	store, err := OpenConsentStore(filesystem.NewOS(), consentPath(t))
	if err != nil {
		t.Fatalf("OpenConsentStore: %v", err)
	}
	dests := make([]ProviderDestination, 8)
	for i := range dests {
		dests[i] = remoteDestination("remote", fmt.Sprintf("https://host-%d.example.com", i))
	}
	var wg sync.WaitGroup
	for _, dest := range dests {
		wg.Add(2)
		go func() {
			defer wg.Done()
			if err := store.Grant(dest); err != nil {
				t.Errorf("Grant(%s): %v", dest.Endpoint, err)
			}
		}()
		go func() {
			defer wg.Done()
			for range 100 {
				store.Has(dest.Digest)
			}
		}()
	}
	wg.Wait()
	for _, dest := range dests {
		if !store.Has(dest.Digest) {
			t.Errorf("Has(%s) = false after concurrent grants", dest.Endpoint)
		}
	}
}

// F2: the policy admits exactly the DURABLE grant set — proven by reopening
// from disk rather than trusting the in-memory store that made the grant.
func TestDestinationPolicyDerivesFromDurableGrants(t *testing.T) {
	path := consentPath(t)
	fsys := filesystem.NewOS()

	store, err := OpenConsentStore(fsys, path)
	if err != nil {
		t.Fatalf("OpenConsentStore: %v", err)
	}
	dest := remoteDestination("hosted", "https://api.example.com/v1")
	if err := store.Grant(dest); err != nil {
		t.Fatalf("Grant: %v", err)
	}

	reopened, err := OpenConsentStore(fsys, path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	policy := reopened.DestinationPolicy()

	permitted, err := provider.NewDestination("hosted", "https://api.example.com/v1")
	if err != nil {
		t.Fatalf("provider.NewDestination(permitted): %v", err)
	}
	if !policy.Permits(permitted) {
		t.Fatal("policy denied the durably granted destination")
	}
	denied, err := provider.NewDestination("hosted", "https://elsewhere.example.com")
	if err != nil {
		t.Fatalf("provider.NewDestination(denied): %v", err)
	}
	if policy.Permits(denied) {
		t.Fatal("policy permitted a destination that was never granted")
	}
}

// F3: an unavailable store yields the zero policy even with grants sitting on
// disk. verifyPrivateMode is skipped on Windows, so the fixture corrupts the
// file's "version" field rather than its mode bits.
func TestDestinationPolicyFailsClosedWhenUnavailable(t *testing.T) {
	path := consentPath(t)
	fsys := filesystem.NewOS()

	store, err := OpenConsentStore(fsys, path)
	if err != nil {
		t.Fatalf("OpenConsentStore: %v", err)
	}
	dest := remoteDestination("remote", "https://api.example.com/v1")
	if err := store.Grant(dest); err != nil {
		t.Fatalf("Grant: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	doc["version"] = 99
	corrupted, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if err := os.WriteFile(path, corrupted, 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	reopened, err := OpenConsentStore(fsys, path)
	if !errors.Is(err, ErrConsentUnavailable) {
		t.Fatalf("reopen after version corruption = %v, want ErrConsentUnavailable", err)
	}
	if !reopened.DestinationPolicy().IsZero() {
		t.Fatal("DestinationPolicy is not zero for an unavailable store")
	}
}

// F16: a destination destination/v1 cannot construct is refused at grant
// time — nothing is stored, whether the grant comes through Grant or as part
// of a GrantMany batch alongside an otherwise-valid destination.
func TestGrantRefusesUnconstructibleDestination(t *testing.T) {
	path := consentPath(t)
	fsys := filesystem.NewOS()

	store, err := OpenConsentStore(fsys, path)
	if err != nil {
		t.Fatalf("OpenConsentStore: %v", err)
	}
	// "bad/name" is a Firn-canonical provider key (NormalizeEndpoint/digest
	// don't care), but provider.NewDestination refuses any provider name
	// containing "/".
	bad := remoteDestination("bad/name", "https://api.example.com/v1")
	if err := store.Grant(bad); err == nil {
		t.Fatal("Grant accepted a destination that destination/v1 cannot construct")
	}
	if store.Has(bad.Digest) {
		t.Fatal("unconstructible destination became granted in memory")
	}
	reopened, err := OpenConsentStore(fsys, path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if reopened.Has(bad.Digest) {
		t.Fatal("unconstructible destination persisted despite Grant's refusal")
	}

	good := remoteDestination("remote", "https://good.example.com")
	if err := reopened.GrantMany([]ProviderDestination{good, bad}); err == nil {
		t.Fatal("GrantMany accepted a batch containing an unconstructible destination")
	}
	if reopened.Has(good.Digest) || reopened.Has(bad.Digest) {
		t.Fatal("GrantMany partially applied a batch that failed validation")
	}
	final, err := OpenConsentStore(fsys, path)
	if err != nil {
		t.Fatalf("final reopen: %v", err)
	}
	if final.Has(good.Digest) || final.Has(bad.Digest) {
		t.Fatal("an invalid GrantMany batch persisted the good half")
	}
}

// F11: GrantMany never publishes a subset of a batch, in memory or on disk.
func TestGrantManyNeverPublishesASubset(t *testing.T) {
	t.Run("both persist together", func(t *testing.T) {
		path := consentPath(t)
		fsys := filesystem.NewOS()
		store, err := OpenConsentStore(fsys, path)
		if err != nil {
			t.Fatalf("OpenConsentStore: %v", err)
		}
		destA := remoteDestination("remote", "https://a.example.com")
		destB := remoteDestination("remote", "https://b.example.com")
		if err := store.GrantMany([]ProviderDestination{destA, destB}); err != nil {
			t.Fatalf("GrantMany: %v", err)
		}
		if !store.Has(destA.Digest) || !store.Has(destB.Digest) {
			t.Fatal("GrantMany did not grant both destinations in memory")
		}

		reopened, err := OpenConsentStore(fsys, path)
		if err != nil {
			t.Fatalf("reopen: %v", err)
		}
		if !reopened.Has(destA.Digest) || !reopened.Has(destB.Digest) {
			t.Fatal("reopen lost one of the batch-granted destinations")
		}
	})

	t.Run("before-rename failure publishes neither", func(t *testing.T) {
		path := consentPath(t)
		failing := &renameFailFS{OS: filesystem.NewOS(), fail: true}
		store, err := OpenConsentStore(failing, path)
		if err != nil {
			t.Fatalf("OpenConsentStore: %v", err)
		}
		destA := remoteDestination("remote", "https://c.example.com")
		destB := remoteDestination("remote", "https://d.example.com")
		if err := store.GrantMany([]ProviderDestination{destA, destB}); err == nil {
			t.Fatal("GrantMany succeeded despite a pre-rename write failure")
		}
		if store.Has(destA.Digest) || store.Has(destB.Digest) {
			t.Fatal("a failed GrantMany mutated the in-memory set")
		}

		recovered, err := OpenConsentStore(filesystem.NewOS(), path)
		if err != nil {
			t.Fatalf("recovery reopen: %v", err)
		}
		if recovered.Has(destA.Digest) || recovered.Has(destB.Digest) {
			t.Fatal("a pre-rename failure still published part of the batch")
		}
	})

	t.Run("after-rename failure recovers the complete batch", func(t *testing.T) {
		path := consentPath(t)
		failing := &lstatFailFS{OS: filesystem.NewOS()}
		store, err := OpenConsentStore(failing, path)
		if err != nil {
			t.Fatalf("OpenConsentStore: %v", err)
		}
		destA := remoteDestination("remote", "https://e.example.com")
		destB := remoteDestination("remote", "https://f.example.com")

		failing.fail = true
		if err := store.GrantMany([]ProviderDestination{destA, destB}); err == nil {
			t.Fatal("GrantMany succeeded despite a post-rename verification failure")
		}
		if store.Has(destA.Digest) || store.Has(destB.Digest) {
			t.Fatal("a failed GrantMany advanced the in-memory set despite unverified persistence")
		}

		// The rename itself succeeded before Lstat was asked to verify it, so
		// the complete batch is durable; a fresh, non-failing open recovers
		// BOTH destinations — never exactly one.
		recovered, err := OpenConsentStore(filesystem.NewOS(), path)
		if err != nil {
			t.Fatalf("recovery reopen: %v", err)
		}
		if !recovered.Has(destA.Digest) || !recovered.Has(destB.Digest) {
			t.Fatal("a post-rename failure did not leave the complete batch durable")
		}
	})
}
