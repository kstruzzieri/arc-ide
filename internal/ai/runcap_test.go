package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/kstruzzieri/go-llm/agent"
	"github.com/kstruzzieri/go-llm/golem"
	"github.com/kstruzzieri/go-llm/provider"
)

// TestGolemStopReasonVocabulary pins the exact strings golem puts in a
// run.finished payload's stopReason. The frontend maps each one to the sentence
// it shows the user (STOP_REASON_CAUSE in frontend/src/stores/golemStore.ts),
// and go-llm is a pinned dependency that gets bumped: a renamed or added reason
// must fail here rather than silently degrade every affected run to the generic
// "it stopped early (...)" wording.
//
// StopReason values are NOT errors -- every one of these ends Orchestrator.Run
// as (result, nil) -- which is why the frontend cannot infer them from an error
// path and has to read this field.
func TestGolemStopReasonVocabulary(t *testing.T) {
	want := map[agent.StopReason]string{
		agent.Completed:           "completed",
		agent.StepCapReached:      "step_cap_reached",
		agent.BudgetReached:       "budget_reached",
		agent.ToolErrorCapReached: "tool_error_cap_reached",
		agent.RepeatLimitReached:  "repeat_limit_reached",
	}
	for reason, text := range want {
		if got := reason.String(); got != text {
			t.Errorf("StopReason(%d).String() = %q, want %q", int(reason), got, text)
		}
	}
	// A reason added upstream lands past the highest one mapped above and
	// stringifies as "unknown"; the frontend would show it verbatim instead of
	// its own sentence, so catch the addition here.
	if next := agent.RepeatLimitReached + 1; next.String() != "unknown" {
		t.Errorf("go-llm added StopReason %q: map it in golemStore.ts STOP_REASON_CAUSE", next)
	}
}

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
	// The zero tuning is production. testTarget declares no context window, so
	// the derived budget is 0 and go-llm applies its own default -- which is
	// what this test wants: it is about the STEP cap, and a run that never
	// evicts is the one that reaches it for the reason under test.
	runner, err := newGolemRunner(context.Background(), root, testTarget("hosted", "big-coder"), nil,
		NewMemorySessionStore(), backend, nil, golemTuning{})
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
