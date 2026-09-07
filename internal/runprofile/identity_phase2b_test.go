package runprofile

import (
	"encoding/json"
	"testing"
)

func decodeJSONPayload(t *testing.T, value any) map[string]any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	return payload
}

func TestRunIdentityCarriesExplicitOrderingAcrossStatusAndOutput(t *testing.T) {
	identity := RunIdentity{
		RunInstanceID:  "opaque-rid",
		ProfileID:      "build",
		WorkspaceEpoch: 7,
		LaunchSeq:      19,
	}

	status := decodeJSONPayload(t, RunStatus{RunIdentity: identity, State: RunStateRunning})
	output := decodeJSONPayload(t, OutputChunk{RunIdentity: identity, Stream: "stdout", Data: "ok"})

	for name, payload := range map[string]map[string]any{"status": status, "output": output} {
		if got := payload["workspaceEpoch"]; got != float64(7) {
			t.Errorf("%s workspaceEpoch = %v, want 7", name, got)
		}
		if got := payload["launchSeq"]; got != float64(19) {
			t.Errorf("%s launchSeq = %v, want 19", name, got)
		}
		if got := payload["runInstanceId"]; got != "opaque-rid" {
			t.Errorf("%s runInstanceId = %v, want opaque-rid", name, got)
		}
	}
}

func TestCompoundSnapshotCarriesAggregateOrderingAndStepEpoch(t *testing.T) {
	aggregate := RunIdentity{
		RunInstanceID:  "aggregate-rid",
		ProfileID:      "ci",
		WorkspaceEpoch: 11,
		LaunchSeq:      23,
	}

	step := compoundStepStatus{
		Idx:                 0,
		RunInstanceID:       "leaf-rid",
		ParentRunInstanceID: aggregate.RunInstanceID,
		ProfileID:           "build",
		Name:                "Build",
		State:               CompoundStepPending,
		WorkspaceEpoch:      11,
		LaunchSeq:           0,
	}

	run := &compoundRun{
		status:  RunStatus{RunIdentity: aggregate, State: RunStateRunning},
		plan:    []executionNode{{step: step}},
		current: 0,
		name:    "CI",
	}
	payload := decodeJSONPayload(t, run.snapshot())

	if got := payload["workspaceEpoch"]; got != float64(11) {
		t.Errorf("aggregate workspaceEpoch = %v, want 11", got)
	}
	if got := payload["launchSeq"]; got != float64(23) {
		t.Errorf("aggregate launchSeq = %v, want 23", got)
	}
	steps, ok := payload["steps"].([]any)
	if !ok || len(steps) != 1 {
		t.Fatalf("steps = %#v, want one step", payload["steps"])
	}
	stepPayload, ok := steps[0].(map[string]any)
	if !ok {
		t.Fatalf("step payload = %#v, want object", steps[0])
	}
	if got := stepPayload["workspaceEpoch"]; got != float64(11) {
		t.Errorf("step workspaceEpoch = %v, want 11", got)
	}
	if got := stepPayload["launchSeq"]; got != float64(0) {
		t.Errorf("step launchSeq = %v, want 0", got)
	}
}
