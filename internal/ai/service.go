package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"path/filepath"
	"slices"
	"sort"
	"sync"
	"time"

	"firn/internal/filesystem"
	agenttools "github.com/kstruzzieri/go-llm/agent/tools"
	"github.com/kstruzzieri/go-llm/config"
	"github.com/kstruzzieri/go-llm/golem"
	"github.com/kstruzzieri/go-llm/provider"

	"github.com/google/uuid"
)

// consentChallengeTTL bounds how long an issued consent challenge stays
// retryable.
const consentChallengeTTL = 10 * time.Minute

// maxAssistantOutputBytes caps the cumulative decoded message.delta text for
// one run (about 32k output tokens) so the frontend's terminal Markdown parse
// stays bounded. This is a per-run text ceiling; Golem's own 128 KiB limit is
// per-event over the whole event JSON, a different (coincidentally equal) unit.
const maxAssistantOutputBytes = 128 << 10

// EventGolemStatusChanged is the payload-free event telling the frontend to
// re-read Golem status. The Wails binding layer emits it as well — on a policy
// manifest reload — so it is exported to keep the two emitters from drifting
// apart silently, which would just stop the UI refreshing without failing.
const EventGolemStatusChanged = "golem:status-changed"

// Host event names emitted through the Wails emit callback.
const (
	eventGolemEvent     = "golem:event"
	eventGolemRunStatus = "golem:run-status"
)

// errServiceClosing marks operations rejected because shutdown began. It is
// deliberately not a public sentinel: SanitizeError collapses it to the
// generic catch-all.
var errServiceClosing = errors.New("golem service is closing")

// runnerFactory is the injection seam for runner construction.
type runnerFactory func(
	context.Context,
	string,
	providerTarget,
	agenttools.ScopeGuard,
	golem.SessionStore,
) (Runner, error)

// convState is the explicit conversation admission state.
type convState string

const (
	stateIdle           convState = "idle"
	statePendingConsent convState = "pending-consent"
	stateStarting       convState = "starting"
	stateRunning        convState = "running"
	stateCanceling      convState = "canceling"
)

// runnerRecord wraps one live Runner with an idempotent close so retirement,
// terminal cleanup, admission rollback, and Close share a single ownership
// path.
type runnerRecord struct {
	runner    Runner
	closeOnce sync.Once
	closeErr  error
}

func (r *runnerRecord) close() error {
	r.closeOnce.Do(func() { r.closeErr = r.runner.Close() })
	return r.closeErr
}

// activeRun is one registered live run. identity/workspaceLabel/cancel/runner/
// conv are immutable after registration; state is guarded by lifecycleMu.
type activeRun struct {
	identity       RunIdentity
	workspaceLabel string
	state          string // running | canceling; guarded by Service.lifecycleMu
	cancel         context.CancelFunc
	runner         *runnerRecord
	conv           *conversationRecord
}

// conversationRecord tracks one deterministic conversation for process life.
//
// Invariant (1:1 conversation -> runner): at most one live runner exists per
// conversation ID. Retirement closes an idle runner immediately and only
// stale-marks a busy one; terminal cleanup then closes the stale-marked
// runner under mu BEFORE the conversation returns to idle, so a re-create for
// the same ID can only follow full quiescence of its predecessor.
type conversationRecord struct {
	id string

	mu                sync.Mutex // admission mutex; guards everything below
	state             convState
	challenge         *ConsentChallenge
	runner            *runnerRecord
	runnerEpoch       uint64
	runnerConfigEpoch uint64 // configEpoch the cached runner was built from
	runnerStale       bool   // retired incarnation's runner; close at terminal cleanup
	active            *activeRun
}

// serviceBinding is one repository incarnation as the Service tracks it.
type serviceBinding struct {
	identity RepositoryIdentity
	repoRoot string
	policy   *ScopePolicy
}

// loadedSnapshot is the process-wide effective configuration: one load
// outcome shared by settings, Status, and StartTurn. Backend-only, never
// serialized. Pointer and configEpoch are guarded by Service.snapshotMu.
type loadedSnapshot struct {
	projection    SettingsProjection
	target        *providerTarget // selected agent target; nil when unresolvable
	targetErr     error           // config loaded but agent target unresolvable
	loadErr       error           // discovery/load failed (sentinel-wrapped)
	lexicalPath   string          // backend-only; Phase 3 apply verification
	canonicalPath string          // backend-only; per-binding protection input
	epoch         uint64          // configEpoch; monotonic per process
}

// Service is the consent-gated asynchronous run lifecycle for Golem chat.
//
// Lock order: bindingGate -> conversation admission mutex -> snapshotMu;
// lifecycleMu as before (taken alone or last, never held while acquiring the
// others); snapshotMu never wraps another lock.
type Service struct {
	fs       filesystem.FileSystem
	emit     func(string, any)
	bindings *Bindings
	consent  *ConsentStore
	sessions *MemorySessionStore

	baseCtx    context.Context
	baseCancel context.CancelFunc

	lifecycleMu   sync.Mutex
	closing       bool
	active        map[string]*activeRun          // run ID -> registered run
	conversations map[string]*conversationRecord // conversation ID -> record
	binding       *serviceBinding                // current incarnation; swapped under bindingGate write
	degraded      error                          // consent degradation cause

	bindingGate sync.RWMutex
	// challengeMu guards pendingApplies exclusively. It is a LEAF: Call 1
	// installs while holding bindingGate, so the only nesting is
	// bindingGate -> challengeMu, and CancelSettingsApply takes it ALONE
	// (Amendment 9) so a cancel can never queue behind a running turn.
	challengeMu    sync.Mutex
	pendingApplies map[string]*settingsChallengeRecord
	// snapshotMu guards snapshot and configEpoch exclusively. Lock order:
	// bindingGate -> conv.mu -> snapshotMu; snapshotMu is also taken alone and
	// never held while acquiring any other Service lock.
	snapshotMu  sync.Mutex
	snapshot    *loadedSnapshot
	configEpoch uint64
	wg          sync.WaitGroup
	closeOnce   sync.Once
	closeDone   chan struct{}
	closeErr    error // published before closeDone closes
	// runClaims is process-lifetime global UUID ownership/tombstones. One
	// entry per admitted turn, never reclaimed (a deleted claim would let a
	// tombstoned run UUID be replayed): ~100 bytes/turn, so a multi-day
	// session with 10k turns costs ~1 MB.
	runClaims map[string]RunIdentity

	loadConfig func() (loadedAgentConfig, error)
	newRunner  runnerFactory
	now        func() time.Time
	newID      func() string
}

// NewService constructs the Service with its production collaborators.
// Package-local tests replace only the four function fields.
//
// ctx must outlive the Service: its cancellation is NOT observed as shutdown.
// Only Close sets `closing` and cancels the derived baseCtx, so a caller ctx
// cancelled without Close leaves every subsequent run context born cancelled
// while Status still reports Available.
func NewService(ctx context.Context, fs filesystem.FileSystem, consentPath string, emit func(string, any)) *Service {
	if emit == nil {
		emit = func(string, any) {}
	}
	baseCtx, baseCancel := context.WithCancel(ctx)
	s := &Service{
		fs:             fs,
		emit:           emit,
		bindings:       NewBindings(fs),
		sessions:       NewMemorySessionStore(), // the one store every runner shares
		baseCtx:        baseCtx,
		baseCancel:     baseCancel,
		active:         make(map[string]*activeRun),
		conversations:  make(map[string]*conversationRecord),
		closeDone:      make(chan struct{}),
		runClaims:      make(map[string]RunIdentity),
		pendingApplies: make(map[string]*settingsChallengeRecord),
		loadConfig:     loadDefaultAgentConfig,
		newRunner:      NewGolemRunner,
		now:            time.Now,
		newID:          uuid.NewString,
	}
	consent, err := OpenConsentStore(fs, consentPath)
	s.consent = consent
	s.degraded = err // nil when the store opened cleanly; Remote stays blocked otherwise
	return s
}

// publicErr host-logs the raw cause under the calling operation's label and
// returns only its fixed public projection; no raw error text ever crosses the
// Wails boundary. op distinguishes otherwise identically shaped log lines
// ("bind", "turn", "cancel", "shutdown").
func (s *Service) publicErr(op string, err error) error {
	pe := SanitizeError(err)
	log.Printf("ai: golem %s %s: %v", op, pe.Code, err)
	return pe
}

// isClosing is the lifecycle-only fast check shared by the entry points that
// reject or no-op once shutdown began.
func (s *Service) isClosing() bool {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	return s.closing
}

func (s *Service) currentBinding() *serviceBinding {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	return s.binding
}

func (s *Service) setBinding(b *serviceBinding) {
	s.lifecycleMu.Lock()
	s.binding = b
	s.lifecycleMu.Unlock()
}

// snapshotOrBuild returns the effective snapshot, building one when absent.
// Building performs config file I/O under snapshotMu only.
func (s *Service) snapshotOrBuild() *loadedSnapshot {
	s.snapshotMu.Lock()
	defer s.snapshotMu.Unlock()
	if s.snapshot == nil {
		s.snapshot = s.buildSnapshotLocked()
	}
	return s.snapshot
}

// buildSnapshotLocked loads the config once and derives projection + run
// target from that single outcome. The expanded config is NOT retained
// (minimal secret residency). Caller holds snapshotMu.
func (s *Service) buildSnapshotLocked() *loadedSnapshot {
	loaded, err := s.loadConfig()
	s.configEpoch++
	sn := &loadedSnapshot{
		projection:    buildSettingsProjection(loaded, err),
		loadErr:       err,
		lexicalPath:   loaded.LexicalPath,
		canonicalPath: loaded.SourcePath,
		epoch:         s.configEpoch,
	}
	if err == nil {
		target, terr := ResolveAgentTarget(loaded.Config)
		if terr != nil {
			sn.targetErr = terr
		} else {
			sn.target = &target
		}
	}
	return sn
}

func (s *Service) conversationFor(id string) *conversationRecord {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	conv, ok := s.conversations[id]
	if !ok {
		conv = &conversationRecord{id: id, state: stateIdle}
		s.conversations[id] = conv
	}
	return conv
}

func (s *Service) conversationsSnapshot() []*conversationRecord {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	out := make([]*conversationRecord, 0, len(s.conversations))
	for _, conv := range s.conversations {
		out = append(out, conv)
	}
	return out
}

// setConsentDegraded records the consent degradation cause; the return
// reports the healthy->degraded transition (emit exactly then).
func (s *Service) setConsentDegraded(cause error) bool {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	was := s.degraded
	s.degraded = cause
	return was == nil
}

// clearConsentDegraded reports the degraded->healthy transition.
func (s *Service) clearConsentDegraded() bool {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	was := s.degraded
	s.degraded = nil
	return was != nil
}

// DestinationPolicy exposes the consent store's exact-grant policy for
// config-driven golem consumers (the commit-message generator). Keys off the
// STORE's availability (loadErr), not the service's degraded-warning
// bookkeeping, which also tracks transient persist failures (spec D2).
func (s *Service) DestinationPolicy() provider.DestinationPolicy {
	return s.consent.DestinationPolicy()
}

// BindRepository makes repoPath the current repository incarnation and returns
// the canonical root it authorized alongside the identity, so no caller has to
// recompute it. A failed bind leaves the previous binding and its attached
// policy fully current; a successful different-root bind retires the previous
// incarnation without canceling its active runs.
func (s *Service) BindRepository(repoPath string) (RepositoryIdentity, string, error) {
	// Resolve the candidate root before locking; Bindings.Bind re-derives the
	// same canonicalization idempotently.
	abs, err := filepath.Abs(repoPath)
	if err != nil {
		return RepositoryIdentity{}, "", s.publicErr("bind", fmt.Errorf("%w: resolving %q: %w", ErrWorkspaceUnavailable, repoPath, err))
	}
	root, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return RepositoryIdentity{}, "", s.publicErr("bind", fmt.Errorf("%w: canonicalizing %q: %w", ErrWorkspaceUnavailable, repoPath, err))
	}
	s.bindingGate.Lock()
	defer s.bindingGate.Unlock()
	// Linearize against shutdown: a commit that checked closing here is
	// ordered before the shutdown writer even if it returns later; a closing
	// service rejects the bind.
	if s.isClosing() {
		return RepositoryIdentity{}, "", s.publicErr("bind", fmt.Errorf("%w: bind rejected", errServiceClosing))
	}
	identity, err := s.bindings.Bind(root)
	if err != nil {
		return RepositoryIdentity{}, "", s.publicErr("bind", err)
	}
	old := s.currentBinding()
	if old != nil && old.identity == identity {
		old.policy.Attach() // same-incarnation refresh: bounded reload before exposure
		return identity, old.repoRoot, nil
	}
	var idle []*runnerRecord
	if old != nil {
		idle = s.retireBinding(old) // retire only after the new root resolved
	}
	next := &serviceBinding{identity: identity, repoRoot: root, policy: LoadScopePolicy(s.fs, root)}
	next.policy.Attach() // bounded manifest reload before exposure
	s.setBinding(next)
	for _, rec := range idle {
		// Retirement closes idle runners immediately. A runtime that fails to
		// quiesce on a repository switch is host-visible only here.
		if err := rec.close(); err != nil {
			log.Printf("ai: golem retirement-on-bind runner close: %v", err)
		}
	}
	return identity, next.repoRoot, nil
}

// UnbindRepository marks the current binding retired without canceling its
// active runs, detaches its policy, and drops its unconsumed challenges
// before releasing the binding writer.
func (s *Service) UnbindRepository() {
	// Lifecycle-only fast check: post-close calls no-op idempotently without
	// waiting on a stuck binding writer.
	if s.isClosing() {
		return
	}
	s.bindingGate.Lock()
	defer s.bindingGate.Unlock()
	if s.isClosing() {
		return // the shutdown writer owns the final retirement
	}
	s.bindings.Unbind()
	old := s.currentBinding()
	if old == nil {
		return
	}
	idle := s.retireBinding(old)
	s.setBinding(nil)
	for _, rec := range idle {
		if err := rec.close(); err != nil {
			log.Printf("ai: golem retirement-on-unbind runner close: %v", err)
		}
	}
}

// retireBinding retires one incarnation while the caller holds bindingGate
// write: detaches its policy (every already-issued guard then denies), drops
// its unconsumed challenges, removes-and-returns its idle runners for
// immediate close, and stale-marks busy runners so terminal cleanup closes
// them. No admission can be mid-flight: admissions hold the read side from
// re-resolution through goroutine launch, so no conversation is `starting`
// here — a run is either registered active or was never admitted.
func (s *Service) retireBinding(b *serviceBinding) []*runnerRecord {
	b.policy.Detach()
	var idle []*runnerRecord
	for _, conv := range s.conversationsSnapshot() {
		conv.mu.Lock()
		if conv.challenge != nil && conv.challenge.Identity.RepoEpoch == b.identity.RepoEpoch {
			conv.challenge = nil
			if conv.state == statePendingConsent {
				conv.state = stateIdle
			}
		}
		if conv.runner != nil && conv.runnerEpoch == b.identity.RepoEpoch {
			if conv.active == nil {
				idle = append(idle, conv.runner)
				conv.runner = nil
				conv.runnerStale = false
			} else {
				conv.runnerStale = true
			}
		}
		conv.mu.Unlock()
	}
	return idle
}

// resolveTurnIdentity validates a request identity against the current
// binding and recomputes the deterministic conversation ID.
func (s *Service) resolveTurnIdentity(id RunIdentity) (ResolvedWorkspace, error) {
	resolved, err := s.bindings.Resolve(id.RepoEpoch, id.WorkspaceID)
	if err != nil {
		return ResolvedWorkspace{}, err
	}
	if ConversationID(resolved.RepoKey, resolved.WorkspaceID) != id.ConversationID {
		return ResolvedWorkspace{}, fmt.Errorf("%w: conversation ID does not match its workspace", ErrRequestRejected)
	}
	return resolved, nil
}

// resolveTargetLocked is the one target-resolution path Status and StartTurn
// share. Loading a snapshot never authorizes its source for a workspace: the
// CURRENT binding's policy protects the canonical source on EVERY call,
// cache hit or not, because policy is per binding incarnation while the
// snapshot lives until reload. Returns the snapshot's configEpoch so
// admission can stamp runner reuse. Caller holds bindingGate and conv.mu.
func (s *Service) resolveTargetLocked(policy *ScopePolicy) (*providerTarget, uint64, error) {
	sn := s.snapshotOrBuild()
	if sn.loadErr != nil {
		return nil, 0, sn.loadErr
	}
	if err := policy.ProtectConfigSource(sn.canonicalPath); err != nil {
		return nil, 0, fmt.Errorf("%w: config source could not be protected: %w", ErrAgentConfigInvalid, err)
	}
	if sn.targetErr != nil {
		return nil, 0, sn.targetErr
	}
	return sn.target, sn.epoch, nil
}

// dropExpiredChallengeLocked invalidates a past-deadline challenge. The
// challenge's run UUID stays tombstoned in runClaims. Caller holds conv.mu.
func (s *Service) dropExpiredChallengeLocked(conv *conversationRecord) {
	if conv.challenge != nil && s.now().UnixMilli() > conv.challenge.ExpiresAt {
		conv.challenge = nil
		if conv.state == statePendingConsent {
			conv.state = stateIdle
		}
	}
}

// Status reports the Golem status for one workspace. It never fails: every
// problem is encoded as Available=false plus a fixed InitError message.
func (s *Service) Status(req StatusRequest) (Status, error) {
	s.bindingGate.RLock()
	defer s.bindingGate.RUnlock()
	st := Status{ActiveRuns: []ActiveRunStatus{}}
	s.lifecycleMu.Lock()
	closing := s.closing
	binding := s.binding
	degraded := s.degraded
	for _, ar := range s.active {
		st.ActiveRuns = append(st.ActiveRuns, ActiveRunStatus{
			Identity:       ar.identity,
			WorkspaceLabel: ar.workspaceLabel,
			State:          ar.state,
		})
	}
	s.lifecycleMu.Unlock()
	sort.Slice(st.ActiveRuns, func(i, j int) bool {
		a, b := st.ActiveRuns[i].Identity, st.ActiveRuns[j].Identity
		if a.ConversationID != b.ConversationID {
			return a.ConversationID < b.ConversationID
		}
		return a.RunID < b.RunID
	})
	if closing {
		st.InitError = SanitizeError(errServiceClosing).Message
		return st, nil
	}
	resolved, err := s.bindings.Resolve(req.RepoEpoch, req.WorkspaceID)
	if err != nil {
		st.InitError = SanitizeError(err).Message
		return st, nil
	}
	st.WorkspaceLabel = resolved.WorkspaceName
	convID := ConversationID(resolved.RepoKey, resolved.WorkspaceID)
	st.Identity = ConversationIdentity{RepoEpoch: resolved.RepoEpoch, WorkspaceID: resolved.WorkspaceID, ConversationID: convID}
	if binding == nil || binding.identity.RepoEpoch != resolved.RepoEpoch {
		st.InitError = SanitizeError(fmt.Errorf("%w: binding changed", ErrRequestRejected)).Message
		return st, nil
	}
	for _, w := range binding.policy.Warnings() {
		st.Warnings = append(st.Warnings, w.Path+": "+w.Message)
	}
	if degraded != nil {
		st.Warnings = append(st.Warnings, SanitizeError(degraded).Message)
	}
	conv := s.conversationFor(convID)
	conv.mu.Lock()
	s.dropExpiredChallengeLocked(conv)
	target, _, terr := s.resolveTargetLocked(binding.policy)
	var challenge *ConsentChallenge
	if ch := conv.challenge; ch != nil &&
		ch.Identity.RepoEpoch == resolved.RepoEpoch &&
		ch.Identity.WorkspaceID == resolved.WorkspaceID &&
		ch.Identity.ConversationID == convID {
		copied := *ch
		challenge = &copied
	}
	conv.mu.Unlock()
	if terr != nil {
		log.Printf("ai: golem status target resolution: %v", terr)
		st.InitError = SanitizeError(terr).Message
		return st, nil
	}
	st.Available = true
	dest := target.destination
	st.Destination = &dest
	if dest.Classification == "remote" {
		st.NeedsConsent = !s.consent.Has(dest.Digest)
	}
	st.ConsentChallenge = challenge
	return st, nil
}

func validateTurnBasics(req TurnRequest) error {
	if !isCanonicalV4RunID(req.Identity.RunID) {
		return fmt.Errorf("%w: run ID is not a canonical v4 UUID", ErrRequestRejected)
	}
	if req.Message == "" {
		return fmt.Errorf("%w: message is empty", ErrRequestRejected)
	}
	if len(req.Message) > MaxTurnMessageBytes {
		return fmt.Errorf("%w: message exceeds %d bytes", ErrRequestRejected, MaxTurnMessageBytes)
	}
	return nil
}

// isCanonicalV4RunID accepts exactly the crypto.randomUUID shape: canonical
// lowercase hyphenated text, version 4, RFC 4122 variant. Uppercase, braced,
// URN, and unhyphenated forms fail the fixed-point check.
func isCanonicalV4RunID(id string) bool {
	parsed, err := uuid.Parse(id)
	if err != nil {
		return false
	}
	return parsed.String() == id && parsed.Version() == 4 && parsed.Variant() == uuid.RFC4122
}

// StartTurn admits one turn. Admission order is fixed:
//  1. register one lifecycle waitgroup unit or reject the closing service;
//  2. resolve epoch/workspace and recompute the conversation ID;
//  3. validate canonical v4 run ID/message and the global RunID claim;
//  4. resolve context refs;
//  5. take bindingGate read, re-resolve, lock the conversation, load or
//     reuse the fixed target without network (protecting the config source);
//  6. under lifecycleMu, recheck closing and claim/reuse the RunID, creating
//     one pending challenge or transitioning a valid retry to `starting`
//     before durably granting/consuming;
//  7. construct or reuse the guarded runner;
//  8. under lifecycleMu, recheck closing, reserve active state, and derive
//     the run context from the service lifetime;
//  9. launch Runner.Run, transferring the registered waitgroup unit;
//  10. return `accepted` immediately.
func (s *Service) StartTurn(ctx context.Context, req TurnRequest) (TurnAdmission, error) {
	// Step 1.
	s.lifecycleMu.Lock()
	if s.closing {
		s.lifecycleMu.Unlock()
		return TurnAdmission{}, s.publicErr("turn", fmt.Errorf("%w: turn rejected", errServiceClosing))
	}
	// This Add must stay inside lifecycleMu: Close sets closing under the same
	// mutex, so no positive Add can land after Close may begin Wait. The
	// placement itself is an ownership invariant, not a tested one --
	// TestServiceCloseVersusConcurrentAdmissions proves the units balance, and
	// the step-8 closing recheck rolls back an admission that slips through, so
	// moving this Add out of the critical section is not observable from a test.
	s.wg.Add(1)
	s.lifecycleMu.Unlock()

	launched := false
	var after []func()
	adm, err := s.admit(ctx, req, &launched, &after)
	if !launched {
		s.wg.Done() // every pre-launch return balances the unit
	}
	for _, fn := range after {
		fn() // status-changed emissions, outside every lock
	}
	if err != nil {
		return TurnAdmission{}, s.publicErr("turn", err)
	}
	return adm, nil
}

func (s *Service) admit(ctx context.Context, req TurnRequest, launched *bool, after *[]func()) (TurnAdmission, error) {
	// Steps 2-4: unlocked preparation; recommitted under the locks below.
	// Step 3's conversation-state check is deliberately deferred to step 6:
	// conv.state is shared state guarded by conv.mu, so reading it here — before
	// bindingGate read + conv.mu are held — would be a genuine data race, and the
	// authoritative check under both locks is the one the spec requires anyway.
	if _, err := s.resolveTurnIdentity(req.Identity); err != nil {
		return TurnAdmission{}, err
	}
	if err := validateTurnBasics(req); err != nil {
		return TurnAdmission{}, err
	}
	s.lifecycleMu.Lock()
	claim, claimed := s.runClaims[req.Identity.RunID]
	s.lifecycleMu.Unlock()
	if claimed && (claim != req.Identity || req.ConsentChallengeID == "") {
		return TurnAdmission{}, fmt.Errorf("%w: run ID was already used", ErrRequestRejected)
	}
	items, err := ResolveContextRefs(ctx, req.ContextRefs)
	if err != nil {
		return TurnAdmission{}, fmt.Errorf("%w: %w", ErrRequestRejected, err)
	}
	receipt := ContextReceipt{Included: len(items)}

	// Step 5: bindingGate read is held from re-resolution through launch, so
	// a later retirement sees `starting` as in flight and an earlier one
	// makes this re-resolution fail.
	s.bindingGate.RLock()
	defer s.bindingGate.RUnlock()
	resolved, err := s.resolveTurnIdentity(req.Identity)
	if err != nil {
		return TurnAdmission{}, err
	}
	binding := s.currentBinding()
	if binding == nil || binding.identity.RepoEpoch != resolved.RepoEpoch {
		return TurnAdmission{}, fmt.Errorf("%w: binding changed during admission", ErrRequestRejected)
	}
	conv := s.conversationFor(req.Identity.ConversationID)
	conv.mu.Lock()
	defer conv.mu.Unlock()
	s.dropExpiredChallengeLocked(conv)
	target, cfgEpoch, err := s.resolveTargetLocked(binding.policy)
	if err != nil {
		return TurnAdmission{}, err
	}
	dest := target.destination

	// Step 6.
	switch conv.state {
	case stateRunning, stateCanceling, stateStarting:
		return TurnAdmission{}, fmt.Errorf("%w: conversation already has an active run", ErrRequestRejected)
	case statePendingConsent:
		if err := s.commitConsentRetry(conv, req, dest); err != nil {
			return TurnAdmission{}, err
		}
		// Durable grant strictly before consumption and construction.
		if err := s.consent.Grant(dest); err != nil {
			// Retain the unconsumed challenge. This sticks ONLY because the
			// steps 7-9 rollback defer below is deliberately not registered
			// yet: registering it earlier (the conventional "clean up early"
			// refactor) would overwrite this with stateIdle while
			// conv.challenge stays live, so the retry falls into `case
			// stateIdle` and is rejected as having no pending challenge --
			// permanently wedging a challenge whose run UUID is tombstoned.
			conv.state = statePendingConsent
			if s.setConsentDegraded(err) {
				*after = append(*after, func() { s.emit(EventGolemStatusChanged, nil) })
			}
			return TurnAdmission{}, err
		}
		if s.clearConsentDegraded() {
			*after = append(*after, func() { s.emit(EventGolemStatusChanged, nil) })
		}
		conv.challenge = nil // consume exactly once
	case stateIdle:
		if req.ConsentChallengeID != "" {
			return TurnAdmission{}, fmt.Errorf("%w: no pending consent challenge", ErrRequestRejected)
		}
		if dest.Classification == "remote" && !s.consent.Has(dest.Digest) {
			ch, err := s.commitChallenge(conv, req.Identity, dest)
			if err != nil {
				return TurnAdmission{}, err
			}
			return TurnAdmission{
				State:            "needs_consent",
				Identity:         req.Identity,
				Destination:      dest,
				Context:          receipt,
				ConsentChallenge: ch,
			}, nil
		}
		if err := s.commitStarting(conv, req.Identity); err != nil {
			return TurnAdmission{}, err
		}
	default:
		return TurnAdmission{}, fmt.Errorf("%w: conversation state %q", ErrRequestRejected, conv.state)
	}

	// Steps 7-9 are one transaction with a single deferred rollback: every
	// post-`starting`, pre-launch exit restores a non-wedged idle state (the
	// grant, if any, is durable, so future admission can use it), removes any
	// provisional active entry, and closes a newly constructed runner exactly
	// once — never a previously cached one. The claim stays tombstoned.
	var newRec *runnerRecord
	var registered *activeRun
	committed := false
	// Registered AFTER `defer s.bindingGate.RUnlock()` and `defer
	// conv.mu.Unlock()` above so LIFO runs this rollback while BOTH are still
	// held -- it mutates conv.state, conv.active, and s.active. Hoisting the
	// conv.mu Lock/Unlock pair below this line would make the rollback mutate
	// conversation state unlocked: a rare-interleaving data race no test here
	// would catch. Registered AFTER the step-6 switch for the reason spelled
	// out at the Grant-failure branch above.
	defer func() {
		if committed {
			return
		}
		conv.state = stateIdle
		if registered != nil {
			s.lifecycleMu.Lock()
			if s.active[req.Identity.RunID] == registered {
				delete(s.active, req.Identity.RunID)
			}
			s.lifecycleMu.Unlock()
			conv.active = nil
			registered.cancel()
		}
		if newRec != nil {
			if err := newRec.close(); err != nil {
				log.Printf("ai: golem admission rollback runner close: %v", err)
			}
		}
	}()

	// Step 7.
	rec := conv.runner
	if rec != nil && (conv.runnerEpoch != resolved.RepoEpoch || conv.runnerConfigEpoch != cfgEpoch || conv.runnerStale) {
		// Defensive: a retired incarnation's record still cached must fully
		// quiesce before any re-create for this conversation ID. Unreachable
		// by construction -- retireBinding nils idle runners and only
		// stale-marks runners whose conversation is running/canceling, and
		// step 6 already rejected those states -- so log rather than leave a
		// silent dead branch: this line firing means that argument broke.
		log.Printf("ai: golem invariant violated: cached runner repo epoch %d != %d or config epoch %d != %d (stale=%v)",
			conv.runnerEpoch, resolved.RepoEpoch, conv.runnerConfigEpoch, cfgEpoch, conv.runnerStale)
		if err := rec.close(); err != nil {
			log.Printf("ai: golem stale-cached runner close: %v", err)
		}
		conv.runner = nil
		conv.runnerStale = false
		rec = nil
	}
	if rec == nil {
		r, err := s.newRunner(s.baseCtx, resolved.ToolRoot, *target,
			binding.policy.Guard(resolved.WorkspaceRel, resolved.workspaceLexicalRel), s.sessions)
		if err != nil {
			return TurnAdmission{}, fmt.Errorf("%w: runner construction: %w", ErrRunFailed, err)
		}
		newRec = &runnerRecord{runner: r}
		rec = newRec
	}

	// Step 8.
	s.lifecycleMu.Lock()
	if s.closing {
		s.lifecycleMu.Unlock()
		return TurnAdmission{}, fmt.Errorf("%w: shutdown during admission", errServiceClosing)
	}
	runCtx, cancel := context.WithCancel(s.baseCtx) // service lifetime, not the Wails call
	ar := &activeRun{
		identity:       req.Identity,
		workspaceLabel: resolved.WorkspaceName,
		state:          "running",
		cancel:         cancel,
		runner:         rec,
		conv:           conv,
	}
	s.active[req.Identity.RunID] = ar
	s.lifecycleMu.Unlock()
	registered = ar
	conv.state = stateRunning
	conv.active = ar
	conv.runner = rec
	conv.runnerEpoch = resolved.RepoEpoch
	conv.runnerConfigEpoch = cfgEpoch

	// Steps 9-10.
	turn := golem.Turn{
		ThreadID: conv.id,
		RunID:    req.Identity.RunID,
		Message:  req.Message,
		Context:  items,
	}
	committed = true
	*launched = true // the goroutine inherits the registered waitgroup unit
	go s.runTurn(runCtx, cancel, conv, ar, rec, turn)
	return TurnAdmission{State: "accepted", Identity: req.Identity, Destination: dest, Context: receipt}, nil
}

// commitConsentRetry validates the exact pending-consent retry and, under
// lifecycleMu, rechecks closing and transitions the conversation to
// `starting` BEFORE the durable grant/consume. Caller holds conv.mu.
func (s *Service) commitConsentRetry(conv *conversationRecord, req TurnRequest, dest ProviderDestination) error {
	ch := conv.challenge
	if ch == nil || req.ConsentChallengeID == "" || req.ConsentChallengeID != ch.ID || ch.Identity != req.Identity {
		return fmt.Errorf("%w: consent challenge mismatch", ErrRequestRejected)
	}
	if ch.DestinationDigest != dest.Digest || ch.Destination != dest {
		return fmt.Errorf("%w: consent destination changed", ErrRequestRejected)
	}
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	if s.closing {
		return fmt.Errorf("%w: shutdown during admission", errServiceClosing)
	}
	claim, claimed := s.runClaims[req.Identity.RunID]
	if !claimed || claim != req.Identity {
		return fmt.Errorf("%w: run ID claim mismatch", ErrRequestRejected)
	}
	conv.state = stateStarting
	return nil
}

// commitChallenge atomically claims the run UUID and publishes exactly one
// pending challenge bound to the full identity. Caller holds conv.mu.
func (s *Service) commitChallenge(conv *conversationRecord, id RunIdentity, dest ProviderDestination) (*ConsentChallenge, error) {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	if s.closing {
		return nil, fmt.Errorf("%w: shutdown during admission", errServiceClosing)
	}
	if _, claimed := s.runClaims[id.RunID]; claimed {
		return nil, fmt.Errorf("%w: run ID was already used", ErrRequestRejected)
	}
	s.runClaims[id.RunID] = id
	ch := &ConsentChallenge{
		ID:                s.newID(),
		Identity:          id,
		Destination:       dest,
		DestinationDigest: dest.Digest,
		ExpiresAt:         s.now().Add(consentChallengeTTL).UnixMilli(),
	}
	conv.state = statePendingConsent
	conv.challenge = ch
	copied := *ch
	return &copied, nil
}

// commitStarting atomically claims the run UUID for a directly admissible
// run and reserves the `starting` transition. Caller holds conv.mu.
func (s *Service) commitStarting(conv *conversationRecord, id RunIdentity) error {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	if s.closing {
		return fmt.Errorf("%w: shutdown during admission", errServiceClosing)
	}
	if _, claimed := s.runClaims[id.RunID]; claimed {
		return fmt.Errorf("%w: run ID was already used", ErrRequestRejected)
	}
	s.runClaims[id.RunID] = id
	conv.state = stateStarting
	return nil
}

// runTurn owns one admitted run: relay nonterminal events immediately,
// buffer the single terminal, and after Run returns release the active
// reservation and finish runner-retirement cleanup BEFORE emitting that
// terminal — the backend handoff that makes listener-driven queue dispatch
// safe.
func (s *Service) runTurn(ctx context.Context, cancel context.CancelFunc, conv *conversationRecord, ar *activeRun, rec *runnerRecord, turn golem.Turn) {
	defer s.wg.Done()
	defer cancel()
	var terminal *RelayedEvent
	assistantOutputBytes := 0
	sink := func(e golem.Event) error {
		if e.RunID != turn.RunID || e.ThreadID != turn.ThreadID {
			// Cross-run/thread event: stop the run; never emit it.
			return fmt.Errorf("golem event identity mismatch: run %q thread %q", e.RunID, e.ThreadID)
		}
		if e.Type == "message.delta" {
			var delta struct {
				Text string `json:"text"`
			}
			if err := json.Unmarshal(e.Payload, &delta); err != nil {
				cancel()
				return errors.New("golem message.delta payload is invalid")
			}
			if len(delta.Text) > maxAssistantOutputBytes-assistantOutputBytes {
				cancel()
				// Golem returns a latched sink error ahead of the run context
				// error, so this cause — not context.Canceled — is what the
				// terminal-less fallback sanitizes into its public message.
				return fmt.Errorf("%w: %d bytes", ErrAssistantOutputLimit, maxAssistantOutputBytes)
			}
			assistantOutputBytes += len(delta.Text)
		}
		raw, err := json.Marshal(e)
		if err != nil {
			return fmt.Errorf("marshal golem event: %w", err)
		}
		rel := RelayedEvent{
			Protocol: e.Protocol,
			ThreadID: e.ThreadID,
			RunID:    e.RunID,
			Seq:      e.Seq,
			Type:     e.Type,
			Payload:  e.Payload,
			Raw:      string(raw),
		}
		switch e.Type {
		case "run.finished", "run.failed", "run.canceled":
			terminal = &rel
			return nil
		}
		s.emit(eventGolemEvent, rel)
		return nil
	}

	_, err := rec.runner.Run(ctx, turn, sink)
	if err != nil && !isCancellationErr(err) {
		// Host-only diagnostics. A Save refused by the session caps is logged
		// distinctly; its public presentation stays the fixed failure message.
		if errors.Is(err, ErrSessionLimit) {
			log.Printf("ai: golem run %s failed: session memory limit: %v", turn.RunID, err)
		} else {
			log.Printf("ai: golem run %s failed: %v", turn.RunID, err)
		}
	}

	conv.mu.Lock()
	if conv.runnerStale && conv.runner == rec {
		// Retirement handed this runner to terminal cleanup: quiesce it under
		// the conversation mutex so no re-create can precede full retirement.
		if err := rec.close(); err != nil {
			log.Printf("ai: golem terminal-cleanup retirement runner close: %v", err)
		}
		conv.runner = nil
		conv.runnerStale = false
	}
	if conv.active == ar {
		conv.active = nil
		conv.state = stateIdle
	}
	s.lifecycleMu.Lock()
	if s.active[turn.RunID] == ar {
		delete(s.active, turn.RunID)
	}
	s.lifecycleMu.Unlock()
	conv.mu.Unlock()

	if terminal != nil {
		s.emit(eventGolemEvent, *terminal)
		return
	}
	// No Golem terminal was buffered: emit the separate fixed fallback, never a
	// fabricated golem:event. The gate is the missing terminal, not err — a
	// Runner that returns (result, nil) without emitting a terminal would
	// otherwise leave the frontend queue with a run that never completes.
	ev := RunStatusEvent{Identity: ar.identity, State: "failed"}
	if isCancellationErr(err) {
		ev.State = "canceled"
	} else {
		cause := error(ErrRunFailed)
		if err != nil {
			cause = fmt.Errorf("%w: %w", ErrRunFailed, err)
		}
		ev.Message = SanitizeError(cause).Message
	}
	s.emit(eventGolemRunStatus, ev)
}

func isCancellationErr(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

// Cancel cancels by full identity. A registered active run needs only the
// index, so the exact old identity works after the binding changed; a
// pending-consent conversation gets its decline path here instead of a
// fourth Wails API.
func (s *Service) Cancel(id RunIdentity) (bool, error) {
	s.lifecycleMu.Lock()
	ar := s.active[id.RunID]
	s.lifecycleMu.Unlock()
	if ar != nil {
		if ar.identity != id {
			return false, s.publicErr("cancel", fmt.Errorf("%w: cancel identity mismatch", ErrRequestRejected))
		}
		ar.conv.mu.Lock()
		if ar.conv.active == ar && ar.conv.state == stateRunning {
			ar.conv.state = stateCanceling
		}
		s.lifecycleMu.Lock()
		if s.active[id.RunID] == ar {
			ar.state = "canceling"
		}
		s.lifecycleMu.Unlock()
		ar.conv.mu.Unlock()
		ar.cancel()                       // host context cancellation
		ar.runner.runner.Cancel(id.RunID) // runtime cancellation
		return true, nil
	}
	// Pending-consent decline: consume only the exactly matching challenge.
	s.lifecycleMu.Lock()
	conv := s.conversations[id.ConversationID]
	s.lifecycleMu.Unlock()
	if conv != nil {
		conv.mu.Lock()
		if conv.state == statePendingConsent && conv.challenge != nil && conv.challenge.Identity == id {
			conv.challenge = nil
			conv.state = stateIdle
			conv.mu.Unlock()
			// Emit only after unlocking.
			s.emit(eventGolemRunStatus, RunStatusEvent{Identity: id, State: "canceled"})
			return true, nil
		}
		conv.mu.Unlock()
	}
	return false, s.publicErr("cancel", fmt.Errorf("%w: no matching run or pending challenge", ErrRequestRejected))
}

// ReloadPolicy re-reads the manifest rules when absChangedPath is one of the
// current binding's watched manifests.
func (s *Service) ReloadPolicy(absChangedPath string) bool {
	s.bindingGate.Lock()
	defer s.bindingGate.Unlock()
	b := s.currentBinding()
	if b == nil || !b.policy.Watches(absChangedPath) {
		return false
	}
	b.policy.Reload()
	return true
}

// Settings returns the settings projection of the current effective snapshot,
// loading one if none exists. It takes the bindingGate read side FIRST and
// rechecks closing under it. No per-binding source protection runs here: no
// target is published and the projection carries no path or key material. It
// may briefly block behind a reload or bind writer; Status polls share the
// same gate, so this adds no new stall class.
func (s *Service) Settings() (SettingsProjection, error) {
	s.bindingGate.RLock()
	defer s.bindingGate.RUnlock()
	if s.isClosing() {
		return SettingsProjection{}, s.publicErr("settings", fmt.Errorf("%w: settings rejected", errServiceClosing))
	}
	return s.snapshotOrBuild().projection.clone(), nil
}

// ReloadSettings rebuilds the effective snapshot under the idle barrier:
// after expiring stale challenges every conversation must be exactly idle —
// running AND canceling both count as busy. The rebuild is unconditional (a
// latched load failure is recoverable only here). It registers a lifecycle
// waitgroup unit (Close waits for a mid-flight reload), holds the binding
// writer across busy check, load, swap, AND idle-runner close (matching
// BindRepository's retirement ownership), and emits golem:status-changed
// exactly once after release on success.
func (s *Service) ReloadSettings() (SettingsReloadResult, error) {
	s.lifecycleMu.Lock()
	if s.closing {
		s.lifecycleMu.Unlock()
		return SettingsReloadResult{}, s.publicErr("settings-reload", fmt.Errorf("%w: reload rejected", errServiceClosing))
	}
	s.wg.Add(1)
	s.lifecycleMu.Unlock()
	defer s.wg.Done()

	s.bindingGate.Lock()
	if s.isClosing() {
		s.bindingGate.Unlock()
		return SettingsReloadResult{}, s.publicErr("settings-reload", fmt.Errorf("%w: reload rejected", errServiceClosing))
	}
	if s.conversationsBusy() {
		cur := s.snapshotOrBuild().projection.clone()
		s.bindingGate.Unlock()
		return SettingsReloadResult{Busy: true, Projection: cur}, nil
	}

	s.snapshotMu.Lock()
	s.snapshot = s.buildSnapshotLocked()
	sn := s.snapshot
	s.snapshotMu.Unlock()

	s.retireCachedRunners("settings-reload")
	s.bindingGate.Unlock()

	s.emit(EventGolemStatusChanged, nil)
	return SettingsReloadResult{Busy: false, Projection: sn.projection.clone()}, nil
}

// conversationsBusy reports whether the idle barrier must refuse: after
// expiring stale challenges, every conversation has to be exactly idle —
// running AND canceling both count as busy, and so does an unexpired pending
// consent challenge. Caller holds the bindingGate WRITER, which is what makes
// the answer stable for the operation that acts on it.
func (s *Service) conversationsBusy() bool {
	for _, conv := range s.conversationsSnapshot() {
		conv.mu.Lock()
		s.dropExpiredChallengeLocked(conv)
		busy := conv.state != stateIdle
		conv.mu.Unlock()
		if busy {
			return true
		}
	}
	return false
}

// retireCachedRunners closes every cached runner and drops it from its
// conversation. Caller holds the bindingGate WRITER and has established that
// every conversation is idle, so the close happens while no admission can
// construct a replacement before its predecessor fully quiesced — the
// ownership rule BindRepository's retirement follows. A close failure is
// host-only: it never resurrects the cache entry and never turns an already
// published configuration into a false failure.
func (s *Service) retireCachedRunners(op string) {
	for _, conv := range s.conversationsSnapshot() {
		conv.mu.Lock()
		rec := conv.runner
		conv.runner = nil
		conv.runnerStale = false
		conv.mu.Unlock()
		if rec != nil {
			if err := rec.close(); err != nil {
				log.Printf("ai: golem %s runner close: %v", op, err)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Settings writes (spec §5.2). Two calls, one pipeline: Apply/Create prepare
// and either publish or ask for consent, and Confirm re-runs the SAME
// preparation from fresh reads before recording the grant and publishing.
// Nothing is retained between them but the challenge record below.
// ---------------------------------------------------------------------------

// settingsChallengeRecord is the short-lived consent record behind one issued
// token. It holds NO document, request, draft, path, or key value: only the
// expiry, the operation kind, the canonical target and request digests, and
// the destinations the user was actually shown and would be granting.
// Everything else Call 2 needs it recomputes.
type settingsChallengeRecord struct {
	expiresAt     int64
	mode          applyMode
	targetDigest  string
	requestDigest string
	grants        []ReachableDestination
	// revision is set by grant-only records ONLY. The write path stages its own
	// revision inside requestDigest; the approve path stages nothing at all, so
	// the revision it read is the only thing that can prove the listing the
	// user approved still describes the active configuration (R3/I17).
	revision string
}

// matches reports whether a fresh preparation still describes the write the
// user approved. Both digests are compared in constant time: they are the
// values an attacker could otherwise probe for. The request digest binds the
// complete pre and post destination SETS, so a fresh preparation that reaches
// anywhere else can never reproduce it.
func (r *settingsChallengeRecord) matches(targetDigest, requestDigest string) bool {
	return constantTimeEqual(r.targetDigest, targetDigest) &&
		constantTimeEqual(r.requestDigest, requestDigest)
}

// ApplySettings is Call 1 against an existing target.
func (s *Service) ApplySettings(req SettingsApplyRequest) (SettingsApplyResult, error) {
	return s.writeSettings("", req, applyModeExisting)
}

// CreateSettings is Call 1 for a missing target.
func (s *Service) CreateSettings(req SettingsApplyRequest) (SettingsApplyResult, error) {
	return s.writeSettings("", req, applyModeCreate)
}

// ConfirmSettingsApply is Call 2. The frontend resends the complete request
// because Call 1 retained none of it; the operation kind comes from the
// challenge record, so one binding serves both entry points.
func (s *Service) ConfirmSettingsApply(req ConfirmSettingsApplyRequest) (SettingsApplyResult, error) {
	if !validChallengeTokenShape(req.ChallengeToken) {
		// A token this shape can never have been issued, so there is nothing to
		// look up and nothing to consume.
		return *conflictChallenge(consentUnchanged), nil
	}
	// The mode is a placeholder: the consumed record's operation replaces it.
	return s.writeSettings(req.ChallengeToken, req.Request, applyModeExisting)
}

// CancelSettingsApply invalidates one issued challenge. Amendment 9: it takes
// the settings-challenge mutex and NOTHING else — not the idle barrier, not
// the snapshot mutex — so it returns immediately even while a turn holds the
// barrier. It is an atomic map removal and therefore idempotent: an absent,
// expired, or already consumed token is already cancelled.
func (s *Service) CancelSettingsApply(token string) CancelSettingsApplyResult {
	s.takeSettingsChallenge(token)
	return CancelSettingsApplyResult{Status: "cancelled"}
}

// takeSettingsChallenge atomically removes and returns the record for token,
// or nil when there is no live one. The scan is linear and compares every key
// in constant time: a map lookup keyed by the secret would leak it through
// hashing and probe timing, and the map only ever holds the handful of
// challenges one user can have outstanding inside the TTL.
func (s *Service) takeSettingsChallenge(token string) *settingsChallengeRecord {
	s.challengeMu.Lock()
	defer s.challengeMu.Unlock()
	var key string
	var record *settingsChallengeRecord
	for candidate, rec := range s.pendingApplies {
		if constantTimeEqual(candidate, token) {
			key, record = candidate, rec
		}
	}
	if record == nil {
		return nil
	}
	delete(s.pendingApplies, key)
	if s.now().UnixMilli() > record.expiresAt {
		return nil // expired: invalid, and correctly removed on the way out
	}
	return record
}

// installSettingsChallenge publishes one pending record and returns its token.
// Expired records are pruned here, which is what keeps the map bounded by the
// TTL rather than by the number of calls.
func (s *Service) installSettingsChallenge(record *settingsChallengeRecord) string {
	token := newChallengeToken()
	s.challengeMu.Lock()
	defer s.challengeMu.Unlock()
	now := s.now().UnixMilli()
	for key, rec := range s.pendingApplies {
		if now > rec.expiresAt {
			delete(s.pendingApplies, key)
		}
	}
	s.pendingApplies[token] = record
	return token
}

// writeSettings is the whole write path. token is empty for Call 1 and the
// challenge token for Call 2; mode is the caller's for Call 1 and the
// record's for Call 2.
//
// The idle barrier is held from the busy check through save, snapshot
// publication, and runner retirement, so no turn can be admitted against a
// configuration that is mid-publication. Only a closing service fails the
// call: every other outcome is a closed §5.6 domain result.
func (s *Service) writeSettings(token string, req SettingsApplyRequest, mode applyMode) (SettingsApplyResult, error) {
	const op = "settings-write"
	s.lifecycleMu.Lock()
	if s.closing {
		s.lifecycleMu.Unlock()
		return SettingsApplyResult{}, s.publicErr(op, fmt.Errorf("%w: settings write rejected", errServiceClosing))
	}
	s.wg.Add(1)
	s.lifecycleMu.Unlock()
	defer s.wg.Done()

	// Registered FIRST so LIFO runs it LAST: every emit happens after the
	// barrier below is released.
	var after []string
	defer func() {
		for _, name := range after {
			s.emit(name, nil)
		}
	}()

	s.bindingGate.Lock()
	defer s.bindingGate.Unlock()
	if s.isClosing() {
		return SettingsApplyResult{}, s.publicErr(op, fmt.Errorf("%w: settings write rejected", errServiceClosing))
	}
	if s.conversationsBusy() {
		// Busy is the one nonterminal result: nothing is consumed, nothing is
		// written, and the same token retries.
		return SettingsApplyResult{Status: "busy"}, nil
	}

	var record *settingsChallengeRecord
	if token != "" {
		if record = s.takeSettingsChallenge(token); record == nil {
			return *conflictChallenge(consentUnchanged), nil
		}
		// From here every result is terminal for this token.
		mode = record.mode
		// A grant-only challenge approves destinations and authorizes no
		// document write. Refusing it HERE — before its mode can reach request
		// validation, which has no rules for it — is what makes the refusal the
		// §5.2 conflict rather than an argument diagnostic.
		if mode == applyModeGrantOnly {
			return *conflictChallenge(consentUnchanged), nil
		}
		if err := validateConfirmSettingsApplyRequest(
			ConfirmSettingsApplyRequest{ChallengeToken: token, Request: req}, mode); err != nil {
			return *blockingDiagnostics(Diagnostic{Code: codeInvalidArgument}), nil
		}
	}

	prepared, result := prepareSettingsApply(s.baseCtx, req, mode)
	if result != nil {
		return *result, nil
	}
	// Both destination sets come from the freshly prepared documents, never
	// from a draft or a cached snapshot.
	preSet, postSet := reachableDestinations(prepared.prior), reachableDestinations(prepared.doc.Config())
	targetDigest := prepared.target.identityDigest()
	requestDigest := canonicalApplyDigest(req, mode, targetDigest, destinationsOf(preSet), destinationsOf(postSet))

	outcome := consentUnchanged
	if record == nil {
		missing := newRemoteDestinations(preSet, postSet, s.consent)
		if len(missing) > 0 {
			// Nothing is written and the Document is discarded with this frame.
			expiresAt := s.now().Add(consentChallengeTTL).UnixMilli()
			challengeToken := s.installSettingsChallenge(&settingsChallengeRecord{
				expiresAt: expiresAt, mode: mode, targetDigest: targetDigest,
				requestDigest: requestDigest, grants: missing,
			})
			return SettingsApplyResult{Status: "consent_required", Challenge: &ApplyChallenge{
				Token: challengeToken, ExpiresAt: expiresAt,
				Destinations: applyDestinations(missing),
			}}, nil
		}
	} else {
		if !record.matches(targetDigest, requestDigest) {
			return *conflictChallenge(consentUnchanged), nil
		}
		// Consent persistence and config publication are two honest commits:
		// the grants must succeed before a remote config can become live.
		// An empty batch is unreachable today — Call 1 only issues a challenge
		// when it found at least one missing destination — and the guard
		// deliberately skips the degraded-flag reset rather than clearing a
		// degradation nothing in this call proved gone.
		if len(record.grants) > 0 {
			if err := s.grantSettingsDestinations(record.grants, &after); err != nil {
				return *withConsentOutcome(
					blockingDiagnostics(Diagnostic{Code: codeConsentStoreFailed}), consentUncertain), nil
			}
			outcome = consentRecorded
		}
	}
	return s.publishSettingsWrite(prepared, mode, outcome, &after), nil
}

// grantSettingsDestinations commits the challenge's whole batch with one
// atomic write. On error nothing is published by the caller and the outcome
// is uncertain: memory keeps the prior authority, while the complete batch
// may already be durable on disk (never a subset) — spec D2.
func (s *Service) grantSettingsDestinations(grants []ReachableDestination, after *[]string) error {
	if err := s.consent.GrantMany(destinationsOf(grants)); err != nil {
		log.Printf("ai: golem consent batch grant failed: %v", err)
		if s.setConsentDegraded(err) {
			*after = append(*after, EventGolemStatusChanged)
		}
		return err
	}
	if s.clearConsentDegraded() {
		*after = append(*after, EventGolemStatusChanged)
	}
	return nil
}

// publishSettingsWrite is Step S: save, publish the new snapshot, and retire
// the old cached runners — all under the idle barrier the caller still holds.
// Replacement runners are created lazily on the next run.
func (s *Service) publishSettingsWrite(prepared *preparedSettingsApply, mode applyMode, outcome string, after *[]string) SettingsApplyResult {
	var err error
	if mode == applyModeCreate {
		if refusal := s.prepareCreateTarget(prepared.target.path); refusal != nil {
			return *withConsentOutcome(refusal, outcome)
		}
		err = prepared.doc.SaveNew(prepared.target.path)
	} else {
		err = prepared.doc.SaveReplace(prepared.target.path, prepared.target.revision)
	}
	warning, refusal := saveOutcome(err)
	if refusal != nil {
		logSettingsSaveFailure("save", err)
		return *withConsentOutcome(refusal, outcome)
	}
	// The bytes are live (durability uncertainty included). Publish before the
	// barrier is released so the next admission sees the new configuration.
	s.snapshotMu.Lock()
	s.snapshot = s.buildSnapshotLocked()
	sn := s.snapshot
	s.snapshotMu.Unlock()
	s.retireCachedRunners("settings-write")
	*after = append(*after, EventGolemStatusChanged)
	projection := sn.projection.clone()
	return SettingsApplyResult{Status: "applied", Projection: &projection, Warning: warning}
}

// prepareCreateTarget establishes the Create destination: a real, non-symlink,
// owner-only parent directory and a target that does not exist in ANY form —
// including one discovery could not see, such as a dangling symlink. SaveNew
// owns the create-only 0600 publication itself.
func (s *Service) prepareCreateTarget(path string) *SettingsApplyResult {
	dir := filepath.Dir(path)
	if err := filesystem.EnsureDirPerm(s.fs, dir, 0o700); err != nil {
		logSettingsSaveFailure("create parent", err)
		return blockingDiagnostics(Diagnostic{Code: codeConfigSaveFailed})
	}
	info, err := filesystem.Lstat(s.fs, dir)
	if err != nil {
		logSettingsSaveFailure("create parent probe", err)
		return blockingDiagnostics(Diagnostic{Code: codeConfigSaveFailed})
	}
	if err := verifyPrivateMode(info, true); err != nil {
		logSettingsSaveFailure("create parent mode", err)
		return blockingDiagnostics(Diagnostic{Code: codeConfigSaveFailed})
	}
	switch _, err := filesystem.Lstat(s.fs, path); {
	case err == nil:
		return conflictTarget(nil) // something is there that discovery could not see
	case errors.Is(err, fs.ErrNotExist):
		return nil
	default:
		logSettingsSaveFailure("create target probe", err)
		return blockingDiagnostics(Diagnostic{Code: codeConfigSaveFailed})
	}
}

// logSettingsSaveFailure host-logs a save-side failure WITHOUT its cause: a
// save error carries the target path, and §5.4 keeps paths out of the log the
// same way it keeps them off the Wails boundary. The upstream diagnostic code
// is bounded and is the only detail worth keeping.
func logSettingsSaveFailure(stage string, err error) {
	if d, ok := config.DiagnosticOf(err); ok {
		log.Printf("ai: golem settings %s failed: code=%s", stage, d.Code)
		return
	}
	log.Printf("ai: golem settings %s failed", stage)
}

// ---------------------------------------------------------------------------
// Grant-only approval of missing destinations (spec D13). Two calls that share
// the settings write's prologue and its consent commit, and NOTHING else: no
// document is prepared, saved, or published, and no projection is rebuilt.
// Cancel is the settings flow's own CancelSettingsApply, which is mode-blind.
// ---------------------------------------------------------------------------

// PrepareDestinationGrants is Call 1: it reads the ACTIVE configuration and
// asks about every remote destination the agent route reaches that is not
// already granted. A nil prior set is what makes this the whole ungranted
// batch rather than a delta (D13) — with no staged edit there is no
// destination the user has already been living with.
//
// Nothing is written and nothing is retained but the challenge record, which
// binds both halves of the target identity: the file (digest) and its contents
// (revision).
func (s *Service) PrepareDestinationGrants() (DestinationGrantsResult, error) {
	const op = "destination-grants-prepare"
	s.lifecycleMu.Lock()
	if s.closing {
		s.lifecycleMu.Unlock()
		return DestinationGrantsResult{}, s.publicErr(op, fmt.Errorf("%w: approval rejected", errServiceClosing))
	}
	s.wg.Add(1)
	s.lifecycleMu.Unlock()
	defer s.wg.Done()

	s.bindingGate.Lock()
	defer s.bindingGate.Unlock()
	if s.isClosing() {
		return DestinationGrantsResult{}, s.publicErr(op, fmt.Errorf("%w: approval rejected", errServiceClosing))
	}
	if s.conversationsBusy() {
		return DestinationGrantsResult{Status: "busy"}, nil
	}

	// An unavailable store cannot answer "already granted", so every listing it
	// produced would be a guess and every confirmation would fail.
	if !s.consent.Available() {
		return DestinationGrantsResult{Status: "unavailable"}, nil
	}
	target, loaded, missing, err := activeGrantTarget()
	if missing {
		return DestinationGrantsResult{Status: "none"}, nil
	}
	if err != nil || exceedsProjectionBounds(loaded.Config) {
		// No detail: the settings projection's own diagnostics already name
		// what is wrong with the configuration (§5.4).
		return DestinationGrantsResult{Status: "config_invalid"}, nil
	}
	grants := newRemoteDestinations(nil, reachableDestinations(loaded.Config), s.consent)
	if len(grants) == 0 {
		return DestinationGrantsResult{Status: "none"}, nil
	}
	expiresAt := s.now().Add(consentChallengeTTL).UnixMilli()
	token := s.installSettingsChallenge(&settingsChallengeRecord{
		expiresAt: expiresAt, mode: applyModeGrantOnly,
		targetDigest: target.identityDigest(), revision: loaded.Revision, grants: grants,
	})
	return DestinationGrantsResult{Status: "consent_required", Challenge: &ApplyChallenge{
		Token: token, ExpiresAt: expiresAt, Destinations: applyDestinations(grants),
	}}, nil
}

// ConfirmDestinationGrants is Call 2: it consumes the token and records the
// approved batch. The token carries everything the call needs, so nothing is
// resent — there is no request to resend.
//
// Freshness (R3/I17): the configuration is reloaded and BOTH halves of the
// binding are compared. A file that moved, or contents that changed, means the
// listing the user approved no longer describes what is active, so the answer
// is conflict — the token is already consumed and the user re-prepares against
// what is there now. The settings-write path refuses a grant-only record
// symmetrically (writeSettings), so neither flow can spend the other's token.
func (s *Service) ConfirmDestinationGrants(token string) (DestinationGrantsResult, error) {
	const op = "destination-grants-confirm"
	s.lifecycleMu.Lock()
	if s.closing {
		s.lifecycleMu.Unlock()
		return DestinationGrantsResult{}, s.publicErr(op, fmt.Errorf("%w: approval rejected", errServiceClosing))
	}
	s.wg.Add(1)
	s.lifecycleMu.Unlock()
	defer s.wg.Done()

	// Registered FIRST so LIFO runs it LAST: every emit happens after the
	// barrier below is released.
	var after []string
	defer func() {
		for _, name := range after {
			s.emit(name, nil)
		}
	}()

	s.bindingGate.Lock()
	defer s.bindingGate.Unlock()
	if s.isClosing() {
		return DestinationGrantsResult{}, s.publicErr(op, fmt.Errorf("%w: approval rejected", errServiceClosing))
	}
	if s.conversationsBusy() {
		// Busy is the one nonterminal result: nothing is consumed, nothing is
		// recorded, and the same token retries.
		return DestinationGrantsResult{Status: "busy"}, nil
	}

	if !validChallengeTokenShape(token) {
		// A token this shape can never have been issued, so there is nothing to
		// look up and nothing to consume.
		return DestinationGrantsResult{Status: "conflict"}, nil
	}
	record := s.takeSettingsChallenge(token)
	// From here every result is terminal for this token.
	if record == nil || record.mode != applyModeGrantOnly {
		return DestinationGrantsResult{Status: "conflict"}, nil
	}
	target, loaded, _, err := activeGrantTarget()
	if err != nil || !constantTimeEqual(target.identityDigest(), record.targetDigest) ||
		!constantTimeEqual(loaded.Revision, record.revision) {
		return DestinationGrantsResult{Status: "conflict"}, nil
	}
	if err := s.grantSettingsDestinations(record.grants, &after); err != nil {
		return DestinationGrantsResult{Status: "uncertain"}, nil
	}
	// The recorded grants moved the destination policy, so the status changes
	// whether or not the degraded flag also cleared — one announcement, never
	// two.
	if !slices.Contains(after, EventGolemStatusChanged) {
		after = append(after, EventGolemStatusChanged)
	}
	return DestinationGrantsResult{Status: "granted"}, nil
}

// Close shuts the service down. The first call marks `closing` under
// lifecycleMu alone — active registration uses the same mutex, so a run is
// either in the cancellation snapshot or rolls back, and no positive wg.Add
// can occur after the mark — then starts exactly one background shutdown.
// Every call, including the first, selects the finished shutdown against its
// own context: a deadline returns ctx.Err() while the shutdown continues,
// and a later Close observes the same final result.
func (s *Service) Close(ctx context.Context) error {
	s.closeOnce.Do(func() {
		s.lifecycleMu.Lock()
		s.closing = true
		cancels := make([]context.CancelFunc, 0, len(s.active))
		for _, ar := range s.active {
			cancels = append(cancels, ar.cancel)
		}
		s.lifecycleMu.Unlock()
		go s.shutdown(cancels)
	})
	select {
	case <-s.closeDone:
		return s.closeErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

// shutdown is the single background finisher: retire the final binding under
// the binding writer (waiting out any in-flight admission), cancel the
// snapshotted active runs, wait for every pre-mark admission/run unit, then
// close all collected/cached runner records through their sync.Once.
func (s *Service) shutdown(cancels []context.CancelFunc) {
	s.bindingGate.Lock()
	var idle []*runnerRecord
	if old := s.currentBinding(); old != nil {
		s.bindings.Unbind()
		idle = s.retireBinding(old) // detaches the current policy
		s.setBinding(nil)
	}
	s.bindingGate.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	s.wg.Wait()
	var errs []error
	for _, rec := range idle {
		if err := rec.close(); err != nil {
			errs = append(errs, err)
		}
	}
	for _, conv := range s.conversationsSnapshot() {
		conv.mu.Lock()
		rec := conv.runner
		conv.runner = nil
		conv.runnerStale = false
		conv.mu.Unlock()
		if rec != nil {
			if err := rec.close(); err != nil {
				errs = append(errs, err)
			}
		}
	}
	s.baseCancel()
	// Runner close errors carry runtime/transport text that can embed paths;
	// host-log the raw joined cause and publish only its fixed projection.
	if raw := errors.Join(errs...); raw != nil {
		s.closeErr = s.publicErr("shutdown", raw)
	}
	close(s.closeDone) // closeErr is published before this
}
