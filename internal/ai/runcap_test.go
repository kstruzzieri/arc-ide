package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/kstruzzieri/go-llm/golem"
	"github.com/kstruzzieri/go-llm/provider"
)

// TestGolemRunnerStepCapEmitsFinishedWithoutAssistantText pins the wire shape a
// capped tool loop produces, because that shape is the whole reason a run can
// look hung: the orchestrator returns (result, nil) with an empty Answer when a
// cap is hit, so golem emits an ordinary run.finished and the only thing that
// distinguishes it from a real answer is the stopReason field. A consumer that
// drops stopReason renders nothing at all.
func TestGolemRunnerStepCapEmitsFinishedWithoutAssistantText(t *testing.T) {
	root := canonicalTempDir(t)

	// Distinct call+result signatures on every step, so the run reaches the
	// step cap rather than tripping the governor's repeat or tool-error caps
	// first (both of which end the same silent way).
	const steps = 20 // > the orchestrator's default 16-step cap
	script := make([]provider.ChatResponse, 0, steps)
	for i := 0; i < steps; i++ {
		name := fmt.Sprintf("file-%02d.txt", i)
		if err := os.WriteFile(filepath.Join(root, name), []byte(name+" body"), 0o600); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
		script = append(script, scriptedToolCall(
			fmt.Sprintf("c%d", i), "read_file", fmt.Sprintf(`{"path":%q}`, name)))
	}

	backend := &scriptedProvider{name: "hosted", steps: script}
	runner, err := newGolemRunner(context.Background(), root, testTarget("hosted", "big-coder"), nil,
		NewMemorySessionStore(), backend, nil)
	if err != nil {
		t.Fatalf("newGolemRunner: %v", err)
	}
	defer func() {
		if err := runner.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	}()

	var events []golem.Event
	result, err := runner.Run(context.Background(), golem.Turn{
		ThreadID: "thread-cap",
		RunID:    "run-cap",
		Message:  "what is internal/runhistory responsible for?",
		Approver: approveAll{},
	}, collectSink(&events))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Answer != "" {
		t.Fatalf("Answer = %q, want empty: a capped loop never produced one", result.Answer)
	}

	var terminal *golem.Event
	deltas := 0
	for i := range events {
		switch events[i].Type {
		case "message.delta":
			deltas++
		case "run.finished", "run.failed", "run.canceled":
			if terminal != nil {
				t.Fatalf("second terminal %q after %q", events[i].Type, terminal.Type)
			}
			terminal = &events[i]
		}
	}
	if terminal == nil {
		t.Fatal("no terminal event emitted")
	}
	if terminal.Type != "run.finished" {
		t.Fatalf("terminal = %q, want run.finished", terminal.Type)
	}
	if deltas != 0 {
		t.Fatalf("message.delta events = %d, want 0: nothing is rendered for the user", deltas)
	}

	var payload struct {
		StopReason string `json:"stopReason"`
	}
	if err := json.Unmarshal(terminal.Payload, &payload); err != nil {
		t.Fatalf("unmarshal run.finished payload: %v", err)
	}
	if payload.StopReason != "step_cap_reached" {
		t.Fatalf("stopReason = %q, want step_cap_reached", payload.StopReason)
	}
}
