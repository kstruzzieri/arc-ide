package ai

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kstruzzieri/go-llm/config"
	"github.com/kstruzzieri/go-llm/golem"
	"github.com/kstruzzieri/go-llm/provider"
)

// TestDeriveInputCeiling pins how a model's declared context window becomes the
// per-turn input budget.
//
// The window is the model's TOTAL capacity -- input and reply share it -- so the
// budget must always leave the model room to answer. Spending the whole window
// on input is not a conservative choice, it is a broken one.
//
// Two edge cases matter as much as the ordinary one: an undeclared window must
// fall back to go-llm's own default rather than to a number invented here, and a
// very large declared window must be capped, because filling a 256k-token window
// costs minutes of prompt processing on a local server for no measured benefit.
func TestDeriveInputCeiling(t *testing.T) {
	for _, tc := range []struct {
		name   string
		window int
		want   int
	}{
		{"undeclared window defers to go-llm's default", 0, 0},
		{"negative window defers to go-llm's default", -1, 0},
		{"a small window still reserves room for the reply", 4096, 3072},
		{"a mid window still reserves room for the reply", 40960, 30720},
		{"a large window is capped", 256000, maxInputCeiling},
		{"a window whose share exceeds the cap is capped", 65536, maxInputCeiling},
		// A window so small that the reserve rounds it to nothing must not
		// hand the assembler a zero-or-negative budget.
		{"a degenerate window defers to go-llm's default", 1, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := deriveInputCeiling(tc.window); got != tc.want {
				t.Fatalf("deriveInputCeiling(%d) = %d, want %d", tc.window, got, tc.want)
			}
		})
	}
}

// bigContextTarget is a local target whose model declares a context window, so
// the runner has something to derive a budget from.
func bigContextTarget(window int) providerTarget {
	target := testTarget("hosted", "big-coder")
	target.model = config.ModelConfig{
		Name: "big-coder", Provider: "hosted", ContextWindow: window,
	}
	return target
}

// TestRunnerKeepsToolResultsWithinTheModelsContextWindow is the behavior the
// budget exists for. A turn reads one large file and then answers. What the
// model can see on the SECOND call is the whole question: if the tool result was
// evicted to fit the budget, the run paid to read the file and then answered
// without it -- which is what drives a loop to read the same things over and
// over until it hits the step cap.
//
// The two arms differ only in the model's declared context window, so any
// difference in what reaches the provider is the budget's doing.
func TestRunnerKeepsToolResultsWithinTheModelsContextWindow(t *testing.T) {
	// ~60 KB of file content. go-llm estimates roughly four characters per
	// token, so this lands near 15k tokens: comfortably over the 8192-token
	// default and comfortably under the derived ceiling.
	const marker = "MARKER_LINE_THE_MODEL_MUST_STILL_SEE"
	body := marker + "\n" + strings.Repeat("package runhistory // filler line\n", 1800)

	run := func(t *testing.T, window int) []provider.ChatRequest {
		t.Helper()
		root := canonicalTempDir(t)
		if err := os.WriteFile(filepath.Join(root, "store.go"), []byte(body), 0o600); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
		backend := &scriptedProvider{name: "hosted", steps: []provider.ChatResponse{
			scriptedToolCall("c1", "read_file", `{"path":"store.go"}`),
			{Content: "runhistory stores run records."},
		}}
		// The zero tuning is what production passes: the runner derives the
		// budget from the target itself, which is the behavior under test.
		runner, err := newGolemRunner(context.Background(), root,
			bigContextTarget(window), nil, NewMemorySessionStore(), backend, nil, golemTuning{})
		if err != nil {
			t.Fatalf("runner: %v", err)
		}
		defer func() {
			if err := runner.Close(); err != nil {
				t.Errorf("Close: %v", err)
			}
		}()

		if _, err := runner.Run(context.Background(), golem.Turn{
			ThreadID: "t", RunID: "r",
			Message:  "what is internal/runhistory responsible for?",
			Approver: approveAll{},
		}, func(golem.Event) error { return nil }); err != nil {
			t.Fatalf("Run: %v", err)
		}
		got := backend.recorded()
		if len(got) < 2 {
			t.Fatalf("provider saw %d calls, want the tool call and the answer", len(got))
		}
		return got
	}

	sawMarker := func(req provider.ChatRequest) bool {
		for _, m := range req.Messages {
			if strings.Contains(m.Content, marker) {
				return true
			}
		}
		return false
	}

	t.Run("declared window keeps the file the run just read", func(t *testing.T) {
		if !sawMarker(run(t, 256000)[1]) {
			t.Fatal("the second model call lost the tool result: the run read the file and then could not see it")
		}
	})

	// The contrast arm. It is not a wish for this behavior -- it documents that
	// an undeclared window still gets go-llm's small default, so the fallback is
	// a real, visible tradeoff rather than an accident.
	t.Run("undeclared window still evicts under the default budget", func(t *testing.T) {
		if sawMarker(run(t, 0)[1]) {
			t.Fatal("expected the 8192-token default to evict a 15k-token tool result")
		}
	})
}
