//go:build !windows

package runprofile

import (
	"sync"
	"testing"
	"time"
)

// batchCall records one call to the OutputFunc.
type batchCall struct {
	identity  RunIdentity
	stream    string
	data      string
	timestamp int64
}

// batchSpy collects OutputFunc calls.
type batchSpy struct {
	mu    sync.Mutex
	calls []batchCall
}

func (s *batchSpy) receive(id RunIdentity, stream, data string, timestamp int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, batchCall{id, stream, data, timestamp})
}

func (s *batchSpy) snapshot() []batchCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]batchCall, len(s.calls))
	copy(out, s.calls)
	return out
}

// waitForCalls polls until at least n calls have been recorded or timeout expires.
func (s *batchSpy) waitForCalls(n int, timeout time.Duration) bool {
	deadline := time.After(timeout)
	for {
		if len(s.snapshot()) >= n {
			return true
		}
		select {
		case <-deadline:
			return false
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// TestBatcher_BasicFlush verifies that two writes to the same stream are
// coalesced into a single OutputFunc call by the timer.
func TestBatcher_BasicFlush(t *testing.T) {
	spy := &batchSpy{}
	b := newOutputBatcher(spy.receive, 16*time.Millisecond)
	defer b.Close()

	b.Write(RunIdentity{RunInstanceID: "p1", ProfileID: "p1"}, "stdout", "hello ", 1000)
	b.Write(RunIdentity{RunInstanceID: "p1", ProfileID: "p1"}, "stdout", "world", 1001)

	if !spy.waitForCalls(1, 500*time.Millisecond) {
		t.Fatal("timed out waiting for a flush")
	}

	calls := spy.snapshot()
	if len(calls) != 1 {
		t.Fatalf("expected 1 call, got %d: %+v", len(calls), calls)
	}
	if calls[0].data != "hello world" {
		t.Errorf("data = %q, want %q", calls[0].data, "hello world")
	}
}

// TestBatcher_SeparateStreams verifies that stdout and stderr produce
// separate OutputFunc calls.
func TestBatcher_SeparateStreams(t *testing.T) {
	spy := &batchSpy{}
	b := newOutputBatcher(spy.receive, 16*time.Millisecond)
	defer b.Close()

	b.Write(RunIdentity{RunInstanceID: "p1", ProfileID: "p1"}, "stdout", "out", 1000)
	b.Write(RunIdentity{RunInstanceID: "p1", ProfileID: "p1"}, "stderr", "err", 1001)

	if !spy.waitForCalls(2, 500*time.Millisecond) {
		t.Fatal("timed out waiting for 2 flush calls")
	}

	calls := spy.snapshot()
	if len(calls) != 2 {
		t.Fatalf("expected 2 calls (one per stream), got %d", len(calls))
	}

	streams := map[string]string{}
	for _, c := range calls {
		streams[c.stream] = c.data
	}
	if streams["stdout"] != "out" {
		t.Errorf("stdout = %q, want %q", streams["stdout"], "out")
	}
	if streams["stderr"] != "err" {
		t.Errorf("stderr = %q, want %q", streams["stderr"], "err")
	}
}

// TestBatcher_CloseFlushesRemaining verifies that Close() flushes any data
// that has accumulated before the next timer tick.
func TestBatcher_CloseFlushesRemaining(t *testing.T) {
	spy := &batchSpy{}
	// Use a very long interval so the timer won't fire during the test.
	b := newOutputBatcher(spy.receive, 10*time.Second)

	b.Write(RunIdentity{RunInstanceID: "p1", ProfileID: "p1"}, "stdout", "pending data", 2000)

	// Close should flush synchronously.
	b.Close()

	calls := spy.snapshot()
	if len(calls) != 1 {
		t.Fatalf("expected 1 call after Close, got %d", len(calls))
	}
	if calls[0].data != "pending data" {
		t.Errorf("data = %q, want %q", calls[0].data, "pending data")
	}
}

// TestBatcher_CloseIdempotent verifies that calling Close() twice does not panic.
func TestBatcher_CloseIdempotent(t *testing.T) {
	b := newOutputBatcher(nil, 16*time.Millisecond)
	b.Close()
	b.Close() // must not panic
}

// TestBatcher_TimestampPreserved verifies that the first write's timestamp is
// used for the batched call, not the last write's timestamp.
func TestBatcher_TimestampPreserved(t *testing.T) {
	spy := &batchSpy{}
	b := newOutputBatcher(spy.receive, 16*time.Millisecond)
	defer b.Close()

	const firstTS int64 = 5000
	const secondTS int64 = 9999

	b.Write(RunIdentity{RunInstanceID: "p1", ProfileID: "p1"}, "stdout", "first", firstTS)
	b.Write(RunIdentity{RunInstanceID: "p1", ProfileID: "p1"}, "stdout", "second", secondTS)

	if !spy.waitForCalls(1, 500*time.Millisecond) {
		t.Fatal("timed out waiting for flush")
	}

	calls := spy.snapshot()
	if calls[0].timestamp != firstTS {
		t.Errorf("timestamp = %d, want %d (first write's timestamp)", calls[0].timestamp, firstTS)
	}
}

// TestBatcher_NilOutputFn verifies that a nil outputFn doesn't cause a panic.
func TestBatcher_NilOutputFn(t *testing.T) {
	b := newOutputBatcher(nil, 16*time.Millisecond)
	defer b.Close()

	// These should not panic.
	b.Write(RunIdentity{RunInstanceID: "p1", ProfileID: "p1"}, "stdout", "data", 1000)
	time.Sleep(50 * time.Millisecond) // let the timer fire
}

// TestBatcher_QuietProcessFlushes verifies that data is flushed by the timer
// even when no additional writes arrive after the initial write.
func TestBatcher_QuietProcessFlushes(t *testing.T) {
	spy := &batchSpy{}
	b := newOutputBatcher(spy.receive, 16*time.Millisecond)
	defer b.Close()

	b.Write(RunIdentity{RunInstanceID: "p1", ProfileID: "p1"}, "stdout", "quiet data", 3000)

	// Wait longer than one tick — data should flush on its own.
	if !spy.waitForCalls(1, 500*time.Millisecond) {
		t.Fatal("timed out waiting for timer-triggered flush")
	}

	calls := spy.snapshot()
	if calls[0].data != "quiet data" {
		t.Errorf("data = %q, want %q", calls[0].data, "quiet data")
	}
}
