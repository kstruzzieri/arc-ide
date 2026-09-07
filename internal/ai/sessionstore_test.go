package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/kstruzzieri/go-llm/conversation"
)

func mustSave(t *testing.T, s *MemorySessionStore, conv conversation.Conversation) {
	t.Helper()
	if err := s.Save(context.Background(), conv); err != nil {
		t.Fatalf("Save(%q): %v", conv.ID, err)
	}
}

func convOfSize(id string, contentBytes int) conversation.Conversation {
	return conversation.Conversation{
		ID:       id,
		Messages: []conversation.Message{{Role: "user", Content: strings.Repeat("x", contentBytes)}},
	}
}

func TestMemorySessionStoreLoadMissingIsNotFound(t *testing.T) {
	s := NewMemorySessionStore()
	if _, err := s.Load(context.Background(), "absent"); !errors.Is(err, conversation.ErrNotFound) {
		t.Fatalf("Load(absent) = %v, want conversation.ErrNotFound", err)
	}
}

func TestMemorySessionStoreRequiresConversationID(t *testing.T) {
	s := NewMemorySessionStore()
	if err := s.Save(context.Background(), conversation.Conversation{}); err == nil {
		t.Fatal("Save with empty ID succeeded, want error")
	}
}

// TestMemorySessionStoreRoundTripIsAliasFree proves the JSON boundary: neither
// the caller's snapshot nor a loaded copy can alias store state, across
// messages, tool-call raw bytes, and the durable summary.
func TestMemorySessionStoreRoundTripIsAliasFree(t *testing.T) {
	s := NewMemorySessionStore()
	toolCalls := json.RawMessage(`[{"id":"call-1"}]`)
	conv := conversation.Conversation{
		ID:    "t1",
		Title: "original title",
		Messages: []conversation.Message{
			{Role: "user", Content: "original user"},
			{Role: "assistant", Content: "original assistant", ToolCalls: toolCalls},
		},
		DurableSummary: &conversation.DurableSummary{Content: "original summary", MessageCount: 2},
	}
	mustSave(t, s, conv)

	// Mutate everything the caller still holds.
	conv.Messages[0].Content = "caller mutated"
	conv.DurableSummary.Content = "caller mutated"
	for i := range toolCalls {
		toolCalls[i] = '!'
	}

	assertOriginal := func(got *conversation.Conversation) {
		t.Helper()
		if got.Title != "original title" ||
			got.Messages[0].Content != "original user" ||
			got.Messages[1].Content != "original assistant" ||
			!bytes.Equal(got.Messages[1].ToolCalls, []byte(`[{"id":"call-1"}]`)) ||
			got.DurableSummary == nil || got.DurableSummary.Content != "original summary" ||
			got.DurableSummary.MessageCount != 2 {
			t.Fatalf("stored snapshot corrupted: %+v", got)
		}
	}

	loaded, err := s.Load(context.Background(), "t1")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	assertOriginal(loaded)

	// Mutate the loaded copy deeply; the store must not see it.
	loaded.Messages[0].Content = "load mutated"
	loaded.DurableSummary.Content = "load mutated"
	for i := range loaded.Messages[1].ToolCalls {
		loaded.Messages[1].ToolCalls[i] = '?'
	}
	again, err := s.Load(context.Background(), "t1")
	if err != nil {
		t.Fatalf("Load again: %v", err)
	}
	assertOriginal(again)
}

func TestMemorySessionStoreReplacementByteAccounting(t *testing.T) {
	s := NewMemorySessionStore()
	mustSave(t, s, convOfSize("a", 1000))
	first := len(s.snaps["a"])
	if s.total != first {
		t.Fatalf("total = %d, want %d", s.total, first)
	}
	mustSave(t, s, convOfSize("a", 5000))
	second := len(s.snaps["a"])
	if second <= first || s.total != second {
		t.Fatalf("replacement accounting: total = %d, snapshot = %d (was %d)", s.total, second, first)
	}
	mustSave(t, s, convOfSize("a", 10))
	if s.total != len(s.snaps["a"]) {
		t.Fatalf("shrink accounting: total = %d, snapshot = %d", s.total, len(s.snaps["a"]))
	}
	mustSave(t, s, convOfSize("b", 1000))
	if s.total != len(s.snaps["a"])+len(s.snaps["b"]) {
		t.Fatalf("multi-ID accounting: total = %d", s.total)
	}
}

func TestMemorySessionStoreRefusesOversizedSnapshot(t *testing.T) {
	s := NewMemorySessionStore()
	mustSave(t, s, convOfSize("a", 100))
	prior := append([]byte(nil), s.snaps["a"]...)
	priorTotal := s.total

	if err := s.Save(context.Background(), convOfSize("a", SessionSnapshotLimit)); !errors.Is(err, ErrSessionLimit) {
		t.Fatalf("oversized Save = %v, want ErrSessionLimit", err)
	}
	if s.total != priorTotal || !bytes.Equal(s.snaps["a"], prior) {
		t.Fatal("rejected oversized replacement disturbed prior snapshot or accounting")
	}
	if err := s.Save(context.Background(), convOfSize("fresh", SessionSnapshotLimit)); !errors.Is(err, ErrSessionLimit) {
		t.Fatalf("oversized fresh Save = %v, want ErrSessionLimit", err)
	}
	if _, ok := s.snaps["fresh"]; ok {
		t.Fatal("rejected snapshot was stored")
	}
}

func TestMemorySessionStoreRefusesWhenTotalWouldExceed(t *testing.T) {
	s := NewMemorySessionStore()
	// Fill close to the store limit with snapshots each below the per-snapshot cap.
	pad := SessionSnapshotLimit - (4 << 10)
	for i := 0; s.total+SessionSnapshotLimit <= SessionStoreLimit; i++ {
		mustSave(t, s, convOfSize(fmt.Sprintf("pad-%d", i), pad))
	}
	mustSave(t, s, convOfSize("small", 16))
	priorSmall := append([]byte(nil), s.snaps["small"]...)
	priorTotal := s.total

	overflow := SessionStoreLimit - s.total + (4 << 10) // content guaranteeing next > limit

	// Total refusal for a new ID: nothing stored, nothing evicted.
	if err := s.Save(context.Background(), convOfSize("new", overflow)); !errors.Is(err, ErrSessionLimit) {
		t.Fatalf("overflowing Save(new) = %v, want ErrSessionLimit", err)
	}
	if _, ok := s.snaps["new"]; ok || s.total != priorTotal {
		t.Fatal("refused save mutated the store")
	}
	if _, err := s.Load(context.Background(), "pad-0"); err != nil {
		t.Fatalf("existing snapshot evicted: %v", err)
	}

	// Total refusal for a replacement: prior bytes and total stay intact.
	if err := s.Save(context.Background(), convOfSize("small", overflow)); !errors.Is(err, ErrSessionLimit) {
		t.Fatalf("overflowing Save(small) = %v, want ErrSessionLimit", err)
	}
	if s.total != priorTotal || !bytes.Equal(s.snaps["small"], priorSmall) {
		t.Fatal("refused replacement disturbed prior snapshot or accounting")
	}
	loaded, err := s.Load(context.Background(), "small")
	if err != nil || loaded.Messages[0].Content != strings.Repeat("x", 16) {
		t.Fatalf("prior snapshot unusable after refusal: %+v, %v", loaded, err)
	}
}

// TestMemorySessionStoreExactLimitBoundaries pins the strict `>` semantics of
// both bounds: exactly at a limit is accepted, one byte over refuses.
func TestMemorySessionStoreExactLimitBoundaries(t *testing.T) {
	overhead := func(id string) int {
		raw, err := json.Marshal(convOfSize(id, 0))
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		return len(raw)
	}

	// Exactly SessionSnapshotLimit bytes is accepted; one byte over refuses.
	s := NewMemorySessionStore()
	exact := SessionSnapshotLimit - overhead("solo")
	mustSave(t, s, convOfSize("solo", exact))
	if got := len(s.snaps["solo"]); got != SessionSnapshotLimit {
		t.Fatalf("snapshot bytes = %d, want exactly %d", got, SessionSnapshotLimit)
	}
	if err := s.Save(context.Background(), convOfSize("solo", exact+1)); !errors.Is(err, ErrSessionLimit) {
		t.Fatalf("Save(snapshot limit+1) = %v, want ErrSessionLimit", err)
	}
	if len(s.snaps["solo"]) != SessionSnapshotLimit {
		t.Fatal("refused +1 replacement disturbed the exact-limit snapshot")
	}

	// A total of exactly SessionStoreLimit is accepted: sixteen snapshots of
	// exactly 1 MiB each, all below the per-snapshot cap.
	s = NewMemorySessionStore()
	for i := 0; i < 16; i++ {
		id := fmt.Sprintf("m-%02d", i)
		mustSave(t, s, convOfSize(id, (1<<20)-overhead(id)))
	}
	if s.total != SessionStoreLimit {
		t.Fatalf("total = %d, want exactly %d", s.total, SessionStoreLimit)
	}
	// One byte over the total refuses: a replacement one byte larger stays
	// under the per-snapshot cap but would make the total limit+1.
	if err := s.Save(context.Background(), convOfSize("m-00", (1<<20)-overhead("m-00")+1)); !errors.Is(err, ErrSessionLimit) {
		t.Fatalf("Save(total limit+1) = %v, want ErrSessionLimit", err)
	}
	if s.total != SessionStoreLimit || len(s.snaps["m-00"]) != 1<<20 {
		t.Fatal("refused +1 replacement disturbed accounting or the prior snapshot")
	}
}

func TestMemorySessionStoreHonorsCancellation(t *testing.T) {
	s := NewMemorySessionStore()
	mustSave(t, s, convOfSize("a", 10))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.Save(ctx, convOfSize("b", 10)); !errors.Is(err, context.Canceled) {
		t.Fatalf("Save(canceled) = %v, want context.Canceled", err)
	}
	if _, ok := s.snaps["b"]; ok {
		t.Fatal("canceled Save stored a snapshot")
	}
	if _, err := s.Load(ctx, "a"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Load(canceled) = %v, want context.Canceled", err)
	}
}

func TestMemorySessionStoreConcurrentLoadSave(t *testing.T) {
	s := NewMemorySessionStore()
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			id := fmt.Sprintf("c%d", g%4)
			for i := 0; i < 100; i++ {
				if err := s.Save(context.Background(), convOfSize(id, 64)); err != nil {
					t.Errorf("Save(%s): %v", id, err)
					return
				}
				if _, err := s.Load(context.Background(), id); err != nil {
					t.Errorf("Load(%s): %v", id, err)
					return
				}
			}
		}(g)
	}
	wg.Wait()
	if s.total != len(s.snaps["c0"])+len(s.snaps["c1"])+len(s.snaps["c2"])+len(s.snaps["c3"]) {
		t.Fatalf("accounting drifted under concurrency: total = %d", s.total)
	}
}
