package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Embed the runtime interface; override only methods exercised by these tests.
// Matching a name alone must never authenticate a replaced window.
type fakeWindow struct {
	application.Window
	id   uint
	name string
}

func (f *fakeWindow) ID() uint     { return f.id }
func (f *fakeWindow) Name() string { return f.name }
func ctxForWindow(w application.Window) context.Context {
	if w == nil {
		return context.Background()
	}
	return context.WithValue(context.Background(), application.WindowKey, w)
}

func TestCallerRoleFromCurrentWindowContext(t *testing.T) {
	mainWindow := &fakeWindow{id: 1, name: "main"}
	satellite := &fakeWindow{id: 2, name: "golem"}
	for _, tc := range []struct {
		name   string
		caller application.Window
		want   string
	}{
		{"main", mainWindow, "main"},
		{"satellite", satellite, "satellite"},
		{"old same-name satellite", &fakeWindow{id: 3, name: "golem"}, ""},
		{"wrong main", &fakeWindow{id: 4, name: "main"}, ""},
		{"absent", nil, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := callerRole(ctxForWindow(tc.caller), mainWindow, satellite)
			if got != tc.want || (err != nil) != (tc.want == "") {
				t.Fatalf("callerRole = %q, %v; want %q", got, err, tc.want)
			}
		})
	}
}

func TestValidateGolemWindowMessageRoles(t *testing.T) {
	ok := json.RawMessage(`{"a":1}`)
	cases := []struct {
		name string
		msg  GolemWindowMessage
		from string
		err  string
	}{
		{"main publishes view", GolemWindowMessage{Kind: "view", Instance: 3, Revision: 1, Payload: ok}, "main", ""},
		{"satellite cannot publish view", GolemWindowMessage{Kind: "view", Instance: 3, Payload: ok}, "satellite", "kind view not allowed from satellite"},
		{"satellite sends action with id", GolemWindowMessage{Kind: "action", Instance: 3, ID: 7, Payload: ok}, "satellite", ""},
		{"action needs an id", GolemWindowMessage{Kind: "action", Instance: 3, Payload: ok}, "satellite", "action requires an id"},
		{"main cannot send action", GolemWindowMessage{Kind: "action", Instance: 3, ID: 1, Payload: ok}, "main", "kind action not allowed from main"},
		{"stale instance", GolemWindowMessage{Kind: "ready", Instance: 2}, "satellite", "stale window instance"},
		{"unknown kind", GolemWindowMessage{Kind: "patch", Instance: 3, Payload: ok}, "main", "unknown kind"},
		{"oversized payload", GolemWindowMessage{Kind: "view", Instance: 3, Revision: 1, Payload: json.RawMessage(strings.Repeat("x", golemWindowMaxPayload+1))}, "main", "payload too large"},
		{"drafts both ways", GolemWindowMessage{Kind: "drafts", Instance: 3, ID: 2, Payload: ok}, "satellite", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateGolemWindowMessage(tc.msg, tc.from, 3)
			if tc.err == "" && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.err != "" && (err == nil || !strings.Contains(err.Error(), tc.err)) {
				t.Fatalf("err = %v, want containing %q", err, tc.err)
			}
		})
	}
}
