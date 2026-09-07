package watcher

import (
	"context"
	"testing"
	"time"
)

func TestMock_ImplementsWatcherInterface(t *testing.T) {
	// This test verifies compilation - the var _ Watcher = (*Mock)(nil)
	// in mock.go handles compile-time verification, but this test
	// exercises the interface at runtime.
	var w Watcher = &Mock{}
	_ = w.Watch(context.Background(), "/test", func(_ FileEvent) {})
	_ = w.Stop()
	_ = w.IsWatching()
	_ = w.WatchedPath()
}

func TestMock_SimulateEvent(t *testing.T) {
	mock := &Mock{}

	var receivedEvent FileEvent
	err := mock.Watch(context.Background(), "/test", func(event FileEvent) {
		receivedEvent = event
	})
	if err != nil {
		t.Fatalf("Watch returned error: %v", err)
	}

	testEvent := FileEvent{
		Type:  EventModified,
		Path:  "/test/file.txt",
		IsDir: false,
		Time:  time.Now(),
	}

	mock.SimulateEvent(testEvent)

	if receivedEvent.Type != EventModified {
		t.Errorf("Expected event type %s, got %s", EventModified, receivedEvent.Type)
	}
	if receivedEvent.Path != "/test/file.txt" {
		t.Errorf("Expected path '/test/file.txt', got %q", receivedEvent.Path)
	}
}

func TestMock_CustomFunctions(t *testing.T) {
	watchCalled := false
	stopCalled := false

	mock := &Mock{
		WatchFunc: func(_ context.Context, path string, _ func(FileEvent)) error {
			watchCalled = true
			if path != "/expected" {
				t.Errorf("Expected path /expected, got %s", path)
			}
			return nil
		},
		StopFunc: func() error {
			stopCalled = true
			return nil
		},
		IsWatchingFunc: func() bool {
			return true
		},
		WatchedPathFunc: func() string {
			return "/expected"
		},
	}

	_ = mock.Watch(context.Background(), "/expected", nil)
	if !watchCalled {
		t.Error("WatchFunc was not called")
	}

	_ = mock.Stop()
	if !stopCalled {
		t.Error("StopFunc was not called")
	}

	if !mock.IsWatching() {
		t.Error("IsWatching should return true")
	}

	if mock.WatchedPath() != "/expected" {
		t.Errorf("WatchedPath should return /expected, got %s", mock.WatchedPath())
	}
}
