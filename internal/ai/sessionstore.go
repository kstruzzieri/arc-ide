package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/kstruzzieri/go-llm/conversation"
)

const (
	// MaxTurnMessageBytes mirrors and pins the current Golem default (64 KiB)
	// at both admission layers.
	MaxTurnMessageBytes = 64 << 10
	// SessionSnapshotLimit bounds one serialized conversation snapshot.
	SessionSnapshotLimit = 2 << 20
	// SessionStoreLimit bounds the sum of all retained snapshots.
	SessionStoreLimit = 16 << 20
)

// ErrSessionLimit reports a Save refused by the per-snapshot or whole-store
// memory bound. A refused replacement leaves the prior snapshot and the byte
// accounting untouched; nothing is ever evicted silently.
var ErrSessionLimit = errors.New("golem session memory limit exceeded")

// MemorySessionStore is Firn's bounded in-memory golem.SessionStore. Each
// conversation is held as its JSON encoding, so every Load and Save crosses a
// serialization boundary: no caller mutation can alias store state, and no
// on-disk sessions.db is ever opened.
//
// There is deliberately no reclamation — no Delete and no eviction: the plan
// requires process-lifetime conversation restoration across unbind/rebind, so
// snapshots of retired conversations intentionally persist until the process
// exits. Known ceilings: SessionStoreLimit (16 MiB) across all conversations
// and SessionSnapshotLimit (2 MiB) per snapshot. A conversation that outgrows
// the per-snapshot bound simply stops persisting: the run surfaces the raw
// ErrSessionLimit-wrapped cause to the host while the public run.failed event
// stays generic. B5 inherits these ceilings as stated instead of
// rediscovering them.
type MemorySessionStore struct {
	mu    sync.Mutex
	snaps map[string][]byte // conversation ID -> JSON snapshot, never mutated in place
	total int               // sum of len over snaps
}

// NewMemorySessionStore returns an empty bounded store.
func NewMemorySessionStore() *MemorySessionStore {
	return &MemorySessionStore{snaps: make(map[string][]byte)}
}

// Load implements golem.SessionStore. A missing ID returns
// conversation.ErrNotFound as the interface contract requires.
func (s *MemorySessionStore) Load(ctx context.Context, id string) (*conversation.Conversation, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	raw, ok := s.snaps[id]
	s.mu.Unlock()
	if !ok {
		return nil, conversation.ErrNotFound
	}
	conv := &conversation.Conversation{}
	if err := json.Unmarshal(raw, conv); err != nil {
		return nil, fmt.Errorf("decode session snapshot: %w", err)
	}
	return conv, nil
}

// Save implements golem.SessionStore: replace or upsert the complete
// snapshot, refusing (without eviction) anything over the per-snapshot or
// whole-store limit.
func (s *MemorySessionStore) Save(ctx context.Context, conv conversation.Conversation) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if conv.ID == "" {
		return errors.New("session snapshot has no conversation ID")
	}
	raw, err := json.Marshal(conv)
	if err != nil {
		return fmt.Errorf("encode session snapshot: %w", err)
	}
	if len(raw) > SessionSnapshotLimit {
		return fmt.Errorf("%w: snapshot exceeds %d bytes", ErrSessionLimit, SessionSnapshotLimit)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.total - len(s.snaps[conv.ID]) + len(raw)
	if next > SessionStoreLimit {
		return fmt.Errorf("%w: store would exceed %d bytes", ErrSessionLimit, SessionStoreLimit)
	}
	s.snaps[conv.ID] = raw
	s.total = next
	return nil
}
