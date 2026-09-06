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

func TestCallerRoleWithTypedNilHandleNeverPanics(t *testing.T) {
	// A typed-nil *application.WebviewWindow boxed into the application.Window
	// interface parameter is a non-nil interface: `handle != nil` passes, and
	// handle.ID() then dereferences a nil receiver. callerRole must normalize
	// this to a genuine nil and return an error, never panic.
	var nilMain *application.WebviewWindow
	var nilSatellite *application.WebviewWindow
	mainWindow := &fakeWindow{id: 1, name: "main"}
	satellite := &fakeWindow{id: 2, name: "golem"}
	caller := &fakeWindow{id: 99, name: "other"}

	for _, tc := range []struct {
		name       string
		mainWindow application.Window
		satellite  application.Window
	}{
		{"typed-nil main handle", nilMain, satellite},
		{"typed-nil satellite handle", mainWindow, nilSatellite},
		{"both handles typed-nil", nilMain, nilSatellite},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := callerRole(ctxForWindow(caller), tc.mainWindow, tc.satellite)
			if err == nil {
				t.Fatalf("callerRole = %q, nil; want an error for an unmatched caller against a typed-nil handle", got)
			}
		})
	}
}

func TestValidateGolemWindowMessageRoles(t *testing.T) {
	ok := json.RawMessage(`{"a":1}`)
	cases := []struct {
		name     string
		msg      GolemWindowMessage
		from     string
		instance uint64
		err      string
	}{
		{"main publishes view", GolemWindowMessage{Kind: "view", Instance: 3, Revision: 1, Payload: ok}, "main", 3, ""},
		{"satellite cannot publish view", GolemWindowMessage{Kind: "view", Instance: 3, Payload: ok}, "satellite", 3, "kind view not allowed from satellite"},
		{"satellite sends action with id", GolemWindowMessage{Kind: "action", Instance: 3, ID: 7, Payload: ok}, "satellite", 3, ""},
		{"action needs an id", GolemWindowMessage{Kind: "action", Instance: 3, Payload: ok}, "satellite", 3, "action requires an id"},
		{"main cannot send action", GolemWindowMessage{Kind: "action", Instance: 3, ID: 1, Payload: ok}, "main", 3, "kind action not allowed from main"},
		{"stale instance", GolemWindowMessage{Kind: "ready", Instance: 2}, "satellite", 3, "stale window instance"},
		{"unknown kind", GolemWindowMessage{Kind: "patch", Instance: 3, Payload: ok}, "main", 3, "unknown kind"},
		{"oversized payload", GolemWindowMessage{Kind: "view", Instance: 3, Revision: 1, Payload: json.RawMessage(strings.Repeat("x", golemWindowMaxPayload+1))}, "main", 3, "payload too large"},
		{"drafts from satellite", GolemWindowMessage{Kind: "drafts", Instance: 3, ID: 2, Payload: ok}, "satellite", 3, ""},
		{"drafts from main", GolemWindowMessage{Kind: "drafts", Instance: 3, ID: 2, Payload: ok}, "main", 3, ""},
		{"ack from main", GolemWindowMessage{Kind: "ack", Instance: 3, Payload: ok}, "main", 3, ""},
		{"ack from satellite", GolemWindowMessage{Kind: "ack", Instance: 3, Payload: ok}, "satellite", 3, ""},
		{"zero window instance rejected", GolemWindowMessage{Kind: "ready", Instance: 0}, "satellite", 0, "stale window instance"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateGolemWindowMessage(tc.msg, tc.from, tc.instance)
			if tc.err == "" && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.err != "" && (err == nil || !strings.Contains(err.Error(), tc.err)) {
				t.Fatalf("err = %v, want containing %q", err, tc.err)
			}
		})
	}
}
