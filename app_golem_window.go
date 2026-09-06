package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// #271 spec §5 — the Golem window contract. Go owns the native window, the
// mode, and the relay; it never interprets a projection or an action payload.

const (
	golemWindowNameMain   = "main"
	golemWindowNameGolem  = "golem"
	golemWindowMaxPayload = 4 << 20

	golemWindowRoleMain      = "main"
	golemWindowRoleSatellite = "satellite"

	eventGolemWindowMode    = "golem:window-mode"
	eventGolemWindowMessage = "golem:window-message"
)

// GolemWindowPhase is the live phase of the Golem window.
type GolemWindowPhase string

const (
	golemPhaseClosed        GolemWindowPhase = "closed"
	golemPhaseBootstrapping GolemWindowPhase = "bootstrapping"
	golemPhaseBootstrapped  GolemWindowPhase = "bootstrapped"
	golemPhaseReady         GolemWindowPhase = "ready"
	golemPhaseClosing       GolemWindowPhase = "closing"
)

// GolemWindowState is what both windows read; emitted on every transition.
type GolemWindowState struct {
	Mode           string           `json:"mode"`
	Phase          GolemWindowPhase `json:"phase"`
	Instance       uint64           `json:"instance"`
	RestorePending bool             `json:"restorePending"`
	StateRevision  uint64           `json:"stateRevision"`
	Handoff        uint64           `json:"handoff"`
}

// GolemWindowMessage is one relayed message. Kind fixes the payload type on
// the frontend; Go validates only the envelope.
type GolemWindowMessage struct {
	Kind     string          `json:"kind"`
	Instance uint64          `json:"instance"`
	Handoff  uint64          `json:"handoff"`
	ID       uint64          `json:"id"`
	Revision uint64          `json:"revision"`
	Payload  json.RawMessage `json:"payload"`
}

// GolemWindowEnvelope is the emitted form: the message plus the verified
// sender role, so a receiver never trusts a self-declared origin.
type GolemWindowEnvelope struct {
	From    string             `json:"from"`
	Message GolemWindowMessage `json:"message"`
}

// GolemWindowBootstrap is the satellite's first read: current state plus the
// latest projection main published (null before the first publish).
type GolemWindowBootstrap struct {
	State    GolemWindowState `json:"state"`
	View     json.RawMessage  `json:"view"`
	Revision uint64           `json:"revision"`
}

// golemWindowKinds maps a kind to the roles allowed to send it.
var golemWindowKinds = map[string]map[string]bool{
	"view":   {golemWindowRoleMain: true},
	"ack":    {golemWindowRoleMain: true, golemWindowRoleSatellite: true},
	"drafts": {golemWindowRoleMain: true, golemWindowRoleSatellite: true},
	"action": {golemWindowRoleSatellite: true},
	"ready":  {golemWindowRoleSatellite: true},
	"abort":  {golemWindowRoleMain: true, golemWindowRoleSatellite: true},
}

// callerRole identifies the actual live handle from beta.16 WindowKey.
// Pass nil for an absent handle, never a typed nil pointer in an interface.
func callerRole(ctx context.Context, mainWindow, satelliteWindow application.Window) (string, error) {
	window, _ := ctx.Value(application.WindowKey).(application.Window)
	if window == nil {
		return "", fmt.Errorf("golem window: caller window unknown")
	}
	if mainWindow != nil && window.ID() == mainWindow.ID() && window.Name() == mainWindow.Name() {
		return golemWindowRoleMain, nil
	}
	if satelliteWindow != nil && window.ID() == satelliteWindow.ID() && window.Name() == satelliteWindow.Name() {
		return golemWindowRoleSatellite, nil
	}
	return "", fmt.Errorf("golem window: caller is not a current Firn window")
}

// validateGolemWindowMessage enforces the envelope contract: known kind, the
// sender's role may use it, the message targets the live window instance,
// id-bearing kinds carry one, and the payload is bounded.
func validateGolemWindowMessage(msg GolemWindowMessage, from string, instance uint64) error {
	roles, ok := golemWindowKinds[msg.Kind]
	if !ok {
		return fmt.Errorf("golem window: unknown kind %q", msg.Kind)
	}
	if !roles[from] {
		return fmt.Errorf("golem window: kind %s not allowed from %s", msg.Kind, from)
	}
	if msg.Instance != instance || instance == 0 {
		return fmt.Errorf("golem window: stale window instance %d (current %d)", msg.Instance, instance)
	}
	if (msg.Kind == "action" || msg.Kind == "drafts") && msg.ID == 0 {
		return fmt.Errorf("golem window: %s requires an id", msg.Kind)
	}
	if len(msg.Payload) > golemWindowMaxPayload {
		return fmt.Errorf("golem window: payload too large (%d bytes)", len(msg.Payload))
	}
	return nil
}
