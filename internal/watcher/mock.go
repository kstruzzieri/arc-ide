package watcher

import "context"

// Mock is a test implementation of the Watcher interface.
type Mock struct {
	WatchFunc       func(ctx context.Context, path string, callback func(FileEvent)) error
	StopFunc        func() error
	IsWatchingFunc  func() bool
	WatchedPathFunc func() string

	// EventCallback stores the callback for SimulateEvent.
	EventCallback func(FileEvent)
}

// Verify Mock implements Watcher interface.
var _ Watcher = (*Mock)(nil)

func (m *Mock) Watch(ctx context.Context, path string, callback func(FileEvent)) error {
	m.EventCallback = callback
	if m.WatchFunc != nil {
		return m.WatchFunc(ctx, path, callback)
	}
	return nil
}

func (m *Mock) Stop() error {
	if m.StopFunc != nil {
		return m.StopFunc()
	}
	return nil
}

func (m *Mock) IsWatching() bool {
	if m.IsWatchingFunc != nil {
		return m.IsWatchingFunc()
	}
	return false
}

func (m *Mock) WatchedPath() string {
	if m.WatchedPathFunc != nil {
		return m.WatchedPathFunc()
	}
	return ""
}

// SimulateEvent triggers the callback with the given event.
// Used in tests to simulate file system changes.
func (m *Mock) SimulateEvent(event FileEvent) {
	if m.EventCallback != nil {
		m.EventCallback(event)
	}
}
