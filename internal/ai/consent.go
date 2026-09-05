package ai

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"path/filepath"
	"runtime"
	"sort"
	"sync"
	"time"

	"firn/internal/filesystem"
	"github.com/kstruzzieri/go-llm/provider"
)

// ConsentStoreLimit bounds a consent file read; anything larger fails closed.
const ConsentStoreLimit = 256 << 10

// consentStoreVersion is the only persisted schema version this build trusts.
const consentStoreVersion = 1

// ErrConsentUnavailable reports that durable consent state cannot be
// established. It never authorizes anything: while a store is unavailable,
// Has is false and Grant fails, so Remote egress stays blocked.
var ErrConsentUnavailable = errors.New("remote consent storage unavailable")

// consentRecord is one persisted grant. Classification is deliberately not
// persisted, and the digest is never trusted on load — both are recomputed
// from provider and endpoint.
type consentRecord struct {
	Digest    string `json:"digest"`
	Provider  string `json:"provider"`
	Endpoint  string `json:"endpoint"`
	GrantedAt string `json:"grantedAt"`
}

// consentFile is the versioned on-disk shape.
type consentFile struct {
	Version int             `json:"version"`
	Grants  []consentRecord `json:"grants"`
}

// ConsentStore is the durable, fail-closed authority over which Remote
// destinations the user has approved. All state transitions happen under the
// mutex; the in-memory grant set only ever advances after a fully durable
// persist.
//
// A store can become unavailable not just from disk/permission failures but
// from a legacy record: parseConsentGrants requires every stored endpoint to
// already equal NormalizeEndpoint's current canonical form, so tightening
// that canonicalization (rejecting "." / ".." path segments, collapsing an
// equivalent IP-literal spelling) makes any older record written under a
// looser rule invalid, and one invalid record fails the WHOLE store closed.
//
// Repair: remove or hand-edit the offending record(s) in
// ~/.firn/golem-consent.json, then re-consent through the chat, settings, or
// approve flows to write a fresh record under the current canonical form.
// The approve action itself cannot repair an unavailable store — Grant
// returns ErrConsentUnavailable immediately when the store failed to open,
// so the file must be fixed (or removed) before any new grant can persist.
type ConsentStore struct {
	fs   filesystem.FileSystem
	path string

	mu      sync.Mutex
	granted map[string]consentRecord // digest -> validated grant
	loadErr error                    // non-nil: unavailable, fail closed
}

// OpenConsentStore opens (or initializes) the consent store at path. Any
// failure — no path, missing durability capability, unverifiable permissions,
// unsyncable parent, or invalid content — returns a non-authorizing store
// together with an error wrapping ErrConsentUnavailable. An empty path makes
// no filesystem call at all. There is no CWD or /tmp fallback.
func OpenConsentStore(fsys filesystem.FileSystem, path string) (*ConsentStore, error) {
	s := &ConsentStore{fs: fsys, path: path}
	if path == "" {
		s.loadErr = fmt.Errorf("%w: no storage path configured", ErrConsentUnavailable)
		return s, s.loadErr
	}
	granted, err := loadConsentGrants(fsys, path)
	if err != nil {
		log.Printf("ai: consent store unavailable: %v", err)
		s.loadErr = fmt.Errorf("%w: consent state could not be validated", ErrConsentUnavailable)
		return s, s.loadErr
	}
	s.granted = granted
	return s, nil
}

// loadConsentGrants runs the open preflight and, only after it succeeds,
// reads and fully validates any existing consent file. The parent directory
// sync runs unconditionally before the file is even probed: a store whose
// directory entries cannot be made durable must not publish grants.
func loadConsentGrants(fsys filesystem.FileSystem, path string) (map[string]consentRecord, error) {
	parent := filepath.Dir(path)
	if err := filesystem.EnsureDirPerm(fsys, parent, 0o700); err != nil {
		return nil, fmt.Errorf("ensuring consent directory: %w", err)
	}
	parentInfo, err := filesystem.Lstat(fsys, parent)
	if err != nil {
		return nil, fmt.Errorf("probing consent directory: %w", err)
	}
	if err := verifyPrivateMode(parentInfo, true); err != nil {
		return nil, fmt.Errorf("verifying consent directory: %w", err)
	}
	if err := filesystem.SyncDirectory(fsys, parent); err != nil {
		return nil, fmt.Errorf("preflight consent directory sync: %w", err)
	}
	info, err := filesystem.Lstat(fsys, path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return map[string]consentRecord{}, nil
		}
		return nil, fmt.Errorf("probing consent file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("consent file is not a regular file")
	}
	if err := verifyPrivateMode(info, false); err != nil {
		return nil, fmt.Errorf("verifying consent file: %w", err)
	}
	data, _, err := filesystem.ReadFileBounded(fsys, path, ConsentStoreLimit)
	if err != nil {
		return nil, fmt.Errorf("reading consent file: %w", err)
	}
	return parseConsentGrants(data)
}

// verifyPrivateMode rejects an object of the wrong kind or, on POSIX, one
// retaining any group/other permission bit. Windows does not model POSIX mode
// bits, so only the type check applies there.
func verifyPrivateMode(info fs.FileInfo, wantDir bool) error {
	if info.IsDir() != wantDir {
		return errors.New("unexpected object type")
	}
	if runtime.GOOS == "windows" {
		return nil
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("mode %o retains group/other bits", info.Mode().Perm())
	}
	return nil
}

// parseConsentGrants validates the entire file and recomputes every record's
// classification and digest; nothing persisted is trusted. Any invalid record
// fails the whole store closed.
func parseConsentGrants(data []byte) (map[string]consentRecord, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var doc consentFile
	if err := dec.Decode(&doc); err != nil {
		return nil, fmt.Errorf("parsing consent file: %w", err)
	}
	if dec.More() {
		return nil, errors.New("consent file carries trailing data")
	}
	if doc.Version != consentStoreVersion {
		return nil, fmt.Errorf("unsupported consent file version %d", doc.Version)
	}
	granted := make(map[string]consentRecord, len(doc.Grants))
	for _, rec := range doc.Grants {
		if rec.Provider == "" {
			return nil, errors.New("consent record has no provider")
		}
		canonical, local, err := NormalizeEndpoint(rec.Endpoint)
		if err != nil {
			return nil, fmt.Errorf("consent record endpoint: %w", err)
		}
		if canonical != rec.Endpoint {
			return nil, errors.New("consent record endpoint is not canonical")
		}
		if local {
			return nil, errors.New("consent record names a local endpoint")
		}
		if destinationDigest(rec.Provider, canonical) != rec.Digest {
			return nil, errors.New("consent record digest does not match its destination")
		}
		if _, dup := granted[rec.Digest]; dup {
			return nil, errors.New("consent file contains a duplicate record")
		}
		granted[rec.Digest] = rec
	}
	return granted, nil
}

// Available reports whether the store opened cleanly. An unavailable store
// fails every operation closed — Has is always false and every Grant returns
// ErrConsentUnavailable — so it can neither answer "already granted" nor
// record a new grant, and a flow whose whole purpose is to record grants must
// refuse up front instead of asking a question it could never honor.
func (s *ConsentStore) Available() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadErr == nil
}

// Has reports whether the destination digest holds a durable grant. An
// unavailable store never authorizes.
func (s *ConsentStore) Has(destinationDigest string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loadErr != nil {
		return false
	}
	_, ok := s.granted[destinationDigest]
	return ok
}

// validateConsentDestination is the single grant-time rule set: provider
// present, canonical Remote endpoint, digest over provider+endpoint, AND a
// constructible destination/v1 identity — so a stored grant is always one
// the policy can render (spec D2/F16).
func validateConsentDestination(destination ProviderDestination) (consentRecord, error) {
	if destination.Provider == "" {
		return consentRecord{}, errors.New("consent destination has no provider")
	}
	canonical, local, err := NormalizeEndpoint(destination.Endpoint)
	if err != nil {
		return consentRecord{}, fmt.Errorf("consent destination endpoint: %w", err)
	}
	if canonical != destination.Endpoint {
		return consentRecord{}, errors.New("consent destination endpoint is not canonical")
	}
	if local {
		return consentRecord{}, errors.New("local destinations do not take consent")
	}
	digest := destinationDigest(destination.Provider, canonical)
	if destination.Digest != digest {
		return consentRecord{}, errors.New("consent destination digest does not match its destination")
	}
	if _, err := provider.NewDestination(destination.Provider, canonical); err != nil {
		log.Printf("ai: consent destination is not a valid destination identity: %v", err)
		return consentRecord{}, errors.New("consent destination is not a valid destination identity")
	}
	return consentRecord{Digest: digest, Provider: destination.Provider, Endpoint: canonical}, nil
}

// persistGrantsLocked encodes, writes atomically, verifies, and only then
// advances the in-memory authority. A failure after the rename may leave
// the complete new set durable on disk; memory keeps the prior set and the
// caller reports uncertain (spec D2).
func (s *ConsentStore) persistGrantsLocked(next map[string]consentRecord) error {
	data, err := encodeConsentFile(next)
	if err != nil {
		log.Printf("ai: consent state encode failed: %v", err)
		return fmt.Errorf("%w: consent state could not be encoded", ErrConsentUnavailable)
	}
	if err := filesystem.WriteFileAtomic(s.fs, s.path, data, 0o600); err != nil {
		log.Printf("ai: consent grant persist failed: %v", err)
		return fmt.Errorf("%w: consent grant could not be persisted", ErrConsentUnavailable)
	}
	info, err := filesystem.Lstat(s.fs, s.path)
	if err != nil {
		log.Printf("ai: consent file stat failed after write: %v", err)
		return fmt.Errorf("%w: consent file could not be verified", ErrConsentUnavailable)
	}
	if err := verifyPrivateMode(info, false); err != nil {
		log.Printf("ai: consent file verification failed after write: %v", err)
		return fmt.Errorf("%w: consent file could not be verified", ErrConsentUnavailable)
	}
	s.granted = next
	return nil
}

// Grant durably records consent for a Remote destination. The destination is
// re-validated from scratch — canonical endpoint, Remote classification,
// recomputed digest, and a constructible destination/v1 identity — and the
// in-memory grant set advances only after the atomic write, its post-rename
// directory sync, and the file-mode check all succeed. Any persistence
// failure keeps the prior in-memory authority.
//
// A Grant error does not mean the grant is recorded nowhere: after a
// post-rename sync failure the new bytes may already be durable on disk, and
// a later open that passes its own parent sync and full validation will treat
// them as authoritative. The error only guarantees THIS store never
// authorizes the destination.
func (s *ConsentStore) Grant(destination ProviderDestination) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loadErr != nil {
		return s.loadErr
	}
	rec, err := validateConsentDestination(destination)
	if err != nil {
		return err
	}
	if _, ok := s.granted[rec.Digest]; ok {
		return nil // idempotent
	}
	next := make(map[string]consentRecord, len(s.granted)+1)
	for k, v := range s.granted {
		next[k] = v
	}
	rec.GrantedAt = time.Now().UTC().Format(time.RFC3339)
	next[rec.Digest] = rec
	return s.persistGrantsLocked(next)
}

// DestinationPolicy renders the durable grant set as go-llm's exact-set
// destination policy (spec D2). An unavailable store yields the zero
// policy — local-only. A legacy record that cannot be rebuilt under
// destination/v1 is skipped and logged (new grants are validated at grant
// time, so this is defense in depth). Firn only ever builds an exact-set
// policy here — never the go-llm variant that grants every destination
// (invariant I3).
func (s *ConsentStore) DestinationPolicy() provider.DestinationPolicy {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loadErr != nil {
		return provider.DestinationPolicy{}
	}
	dests := make([]provider.Destination, 0, len(s.granted))
	for _, rec := range s.granted {
		d, err := provider.NewDestination(rec.Provider, rec.Endpoint)
		if err != nil {
			log.Printf("ai: consent grant unusable as a destination identity: %v", err)
			continue
		}
		dests = append(dests, d)
	}
	return provider.NewDestinationPolicy(dests...)
}

// GrantMany records consent for a batch with ONE atomic write: every
// destination validated up front, the merged set encoded once, memory
// advanced only after write, sync, and mode check succeed. A partial batch
// can never exist on disk or in memory; see persistGrantsLocked for what a
// post-rename failure can leave behind (spec D2/F11).
func (s *ConsentStore) GrantMany(destinations []ProviderDestination) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loadErr != nil {
		return s.loadErr
	}
	next := make(map[string]consentRecord, len(s.granted)+len(destinations))
	for k, v := range s.granted {
		next[k] = v
	}
	now := time.Now().UTC().Format(time.RFC3339)
	changed := false
	for _, destination := range destinations {
		rec, err := validateConsentDestination(destination)
		if err != nil {
			return err
		}
		if _, ok := next[rec.Digest]; ok {
			continue
		}
		rec.GrantedAt = now
		next[rec.Digest] = rec
		changed = true
	}
	if !changed {
		return nil
	}
	return s.persistGrantsLocked(next)
}

// encodeConsentFile marshals the grant set sorted by digest for deterministic
// bytes.
func encodeConsentFile(granted map[string]consentRecord) ([]byte, error) {
	digests := make([]string, 0, len(granted))
	for digest := range granted {
		digests = append(digests, digest)
	}
	sort.Strings(digests)
	doc := consentFile{Version: consentStoreVersion, Grants: make([]consentRecord, 0, len(digests))}
	for _, digest := range digests {
		doc.Grants = append(doc.Grants, granted[digest])
	}
	return json.Marshal(&doc)
}
