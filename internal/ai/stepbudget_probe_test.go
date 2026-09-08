package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kstruzzieri/go-llm/agent"
	"github.com/kstruzzieri/go-llm/golem"
	"github.com/kstruzzieri/go-llm/provider"
)

// The step-budget probe measures where a real Golem turn actually stops when
// the step cap is lifted, so a MaxSteps choice can be made from an uncensored
// distribution instead of from runs that were all truncated at 16.
//
// It is opt-in (FIRN_STEP_PROBE=1) and talks to the operator's own configured
// agent destination. It is never a CI gate: it costs provider time, its
// numbers are model- and corpus-specific, and a local model's step count is
// not a property of Firn worth pinning.
//
//	FIRN_STEP_PROBE=1 \
//	FIRN_STEP_PROBE_MAXSTEPS=48 \
//	FIRN_STEP_PROBE_REPEATS=3 \
//	FIRN_STEP_PROBE_OUT=/tmp/probe.jsonl \
//	go test ./internal/ai/ -run TestStepBudgetProbe -v -timeout 120m

// probeQuestions are ordinary repo-exploration turns of the kind that provoked
// the cap: each needs several reads to answer, none is a trick.
var probeQuestions = []string{
	"what is internal/runhistory responsible for?",
	"what is internal/appstate responsible for?",
	"Which Go package owns PTY terminal sessions, and what is its main type?",
	"How does internal/watcher debounce filesystem events?",
	"What does internal/ai/policy.go enforce? Summarize the rules.",
	"Where does Firn provision managed language servers, and what does it verify before use?",
	"How are run profiles auto-detected from a repository? Name the files consulted.",
	"How does the git package stage a single hunk? Name the functions involved.",
}

// toolEvent is one dispatched tool call, captured with the exact bytes
// go-llm's restraintGovernor hashes (name + raw arguments + capped result
// content), so the probe can recompute its caps rather than guess at them.
type toolEvent struct {
	Step    int    `json:"step"`
	Name    string `json:"name"`
	Args    string `json:"args"`
	IsError bool   `json:"isError"`
	sig     uint64
}

type probeObserver struct {
	steps    []time.Duration
	tools    []toolEvent
	pressure []agent.Pressure
}

func (p *probeObserver) OnStep(_ context.Context, e agent.StepEvent) error {
	p.steps = append(p.steps, e.Latency)
	p.pressure = append(p.pressure, e.Pressure)
	return nil
}

func (p *probeObserver) OnToolCall(context.Context, agent.ToolCallEvent) error { return nil }
func (p *probeObserver) OnToken(context.Context, agent.TokenEvent) error       { return nil }

func (p *probeObserver) OnToolResult(_ context.Context, e agent.ToolResultEvent) error {
	h := fnv.New64a()
	_, _ = h.Write([]byte(e.Call.Function.Name))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write(e.Call.Function.Arguments)
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(e.Result.Content))
	p.tools = append(p.tools, toolEvent{
		Step:    e.Step,
		Name:    e.Call.Function.Name,
		Args:    string(e.Call.Function.Arguments),
		IsError: e.Result.IsError,
		sig:     h.Sum64(),
	})
	return nil
}

// runSample is one measured turn.
type runSample struct {
	Question   string         `json:"question"`
	Model      string         `json:"model"`
	Attempt    int            `json:"attempt"`
	MaxSteps   int            `json:"maxSteps"`
	Steps      int            `json:"steps"`
	ToolCalls  int            `json:"toolCalls"`
	CallsPerSt []int          `json:"callsPerStep"`
	ToolCounts map[string]int `json:"toolCounts"`
	ErrorCalls int            `json:"errorCalls"`
	// PeakErrorRun and PeakRepeatRun are the highest values go-llm's governor
	// counters reached during the run. Both trip at 3, so a peak of 2 is a run
	// that came within one call of being cut off.
	PeakErrorRun  int     `json:"peakConsecutiveErrors"`
	PeakRepeatRun int     `json:"peakRepeatRun"`
	StopReason    string  `json:"stopReason"`
	AnswerBytes   int     `json:"answerBytes"`
	PromptTokens  int     `json:"promptTokens"`
	TotalTokens   int     `json:"totalTokens"`
	WallSeconds   float64 `json:"wallSeconds"`
	// Context-budget telemetry. InputBudget is the ceiling the assembler worked
	// against; Firn sets no golem Budget, so it is go-llm's DefaultInputCeiling.
	// Evicted counts whole GROUPS (a conversation span or a completed tool
	// chain) the assembler DROPPED to fit -- findings the run already paid for
	// and then stopped being able to see.
	InputBudget     int     `json:"inputBudget"`
	PeakInputTokens int     `json:"peakInputTokens"`
	PeakUsedPct     float64 `json:"peakUsedPct"`
	TotalEvicted    int     `json:"totalEvicted"`
	StepsWithEvict  int     `json:"stepsWithEviction"`
	Err             string  `json:"error,omitempty"`
}

// governorPeaks replays the captured calls through the same counter rules the
// orchestrator uses: consecutive errors reset on any success; the repeat
// counter compares against only the IMMEDIATELY preceding signature and starts
// at 1 for a new one, so it reaches 3 on the third identical call in a row.
func governorPeaks(events []toolEvent) (peakErr, peakRepeat int) {
	consecutive, repeat := 0, 0
	var last uint64
	var has bool
	for _, e := range events {
		if e.IsError {
			consecutive++
		} else {
			consecutive = 0
		}
		if consecutive > peakErr {
			peakErr = consecutive
		}
		if has && e.sig == last {
			repeat++
		} else {
			last, has, repeat = e.sig, true, 1
		}
		if repeat > peakRepeat {
			peakRepeat = repeat
		}
	}
	return peakErr, peakRepeat
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

func TestStepBudgetProbe(t *testing.T) {
	if os.Getenv("FIRN_STEP_PROBE") != "1" {
		t.Skip("step-budget probe is opt-in: set FIRN_STEP_PROBE=1")
	}

	loaded, err := loadDefaultAgentConfig()
	if err != nil {
		t.Fatalf("loadDefaultAgentConfig: %v", err)
	}
	target, err := ResolveAgentTarget(loaded.Config)
	if err != nil {
		t.Fatalf("ResolveAgentTarget: %v", err)
	}
	if override := os.Getenv("FIRN_STEP_PROBE_MODEL"); override != "" {
		target.model.Name = override
		target.destination.Model = override
	}
	// A capped run makes many model calls; the configured per-request timeout
	// still applies per call, but a long probe needs room for all of them.
	if target.timeout < 10*time.Minute {
		target.timeout = 10 * time.Minute
	}

	root := os.Getenv("FIRN_STEP_PROBE_ROOT")
	if root == "" {
		wd, err := os.Getwd()
		if err != nil {
			t.Fatalf("Getwd: %v", err)
		}
		root = filepath.Dir(filepath.Dir(wd)) // internal/ai -> repo root
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatalf("EvalSymlinks(%q): %v", root, err)
	}

	maxSteps := envInt("FIRN_STEP_PROBE_MAXSTEPS", 48)
	repeats := envInt("FIRN_STEP_PROBE_REPEATS", 3)
	// Each arm is one input ceiling, in tokens. 0 means "derive from the model's
	// context window", which is production, so the default pair contrasts
	// production against the old unbudgeted behavior -- an explicit 8192, the
	// value go-llm falls back to. Naming a literal equal to what the derivation
	// already returns would make both arms identical and measure nothing.
	//
	// Arms are interleaved per attempt rather than run in blocks so machine load
	// and thermal drift hit every arm equally instead of biasing whichever ran
	// last.
	ceilings := []int{8192, 0}
	if raw := os.Getenv("FIRN_STEP_PROBE_CEILINGS"); raw != "" {
		ceilings = nil
		for _, field := range strings.Split(raw, ",") {
			field = strings.TrimSpace(field)
			if field == "model" {
				ceilings = append(ceilings, target.model.ContextWindow)
				continue
			}
			n, err := strconv.Atoi(field)
			if err != nil {
				t.Fatalf("FIRN_STEP_PROBE_CEILINGS: %q is not an integer or \"model\"", field)
			}
			ceilings = append(ceilings, n)
		}
	}

	backend, transport, err := buildProvider(target)
	if err != nil {
		t.Fatalf("buildProvider: %v", err)
	}
	defer transport.CloseIdleConnections()

	t.Logf("probe: endpoint=%s model=%s ctxWindow=%d root=%s maxSteps=%d repeats=%d ceilings=%v",
		target.destination.Endpoint, target.model.Name, target.model.ContextWindow,
		root, maxSteps, repeats, ceilings)

	outPath := os.Getenv("FIRN_STEP_PROBE_OUT")
	var out *os.File
	if outPath != "" {
		out, err = os.Create(outPath)
		if err != nil {
			t.Fatalf("create %q: %v", outPath, err)
		}
		defer func() { _ = out.Close() }()
	}

	only := os.Getenv("FIRN_STEP_PROBE_ONLY") // substring filter, for smoke runs

	var samples []runSample
	for _, q := range probeQuestions {
		if only != "" && !strings.Contains(q, only) {
			continue
		}
		for attempt := 1; attempt <= repeats; attempt++ {
			for _, ceiling := range ceilings {
				tuning := golemTuning{MaxSteps: maxSteps, InputCeiling: ceiling}
				s := probeOnce(t, root, target, backend, tuning, q, attempt)
				samples = append(samples, s)
				if out != nil {
					raw, _ := json.Marshal(s)
					_, _ = out.Write(append(raw, '\n'))
					_ = out.Sync()
				}
				t.Logf("ceil=%-6d [%d/%d] steps=%2d tools=%2d stop=%-18s peakErr=%d peakRepeat=%d evicted=%d/%dst in=%d/%d tok=%6d %4.0fs  %s",
					s.InputBudget, attempt, repeats, s.Steps, s.ToolCalls, s.StopReason,
					s.PeakErrorRun, s.PeakRepeatRun, s.TotalEvicted, s.StepsWithEvict,
					s.PeakInputTokens, s.InputBudget, s.TotalTokens, s.WallSeconds, s.Question)
			}
		}
	}
	byArm := map[int][]runSample{}
	for _, s := range samples {
		byArm[s.InputBudget] = append(byArm[s.InputBudget], s)
	}
	arms := make([]int, 0, len(byArm))
	for arm := range byArm {
		arms = append(arms, arm)
	}
	sort.Ints(arms)
	for _, arm := range arms {
		t.Logf("")
		t.Logf("############ arm: inputCeiling=%d ############", arm)
		summarize(t, byArm[arm], maxSteps)
	}
}

// probeOnce builds a fresh runtime per turn so no session history leaks between
// samples: every measurement is a cold first turn, which is the shape of the
// question that hit the cap.
func probeOnce(t *testing.T, root string, target providerTarget, backend provider.Provider,
	tuning golemTuning, question string, attempt int) runSample {
	t.Helper()

	s := runSample{
		Question: question, Model: target.model.Name,
		Attempt: attempt, MaxSteps: tuning.MaxSteps,
		ToolCounts: map[string]int{},
	}

	runner, err := newGolemRunner(context.Background(), root, target, nil,
		NewMemorySessionStore(), backend, nil, tuning)
	if err != nil {
		s.Err = err.Error()
		return s
	}
	defer func() { _ = runner.Close() }()

	obs := &probeObserver{}
	start := time.Now()
	result, err := runner.Run(context.Background(), golem.Turn{
		ThreadID: fmt.Sprintf("probe-%d", attempt),
		RunID:    fmt.Sprintf("probe-run-%d-%d", attempt, time.Now().UnixNano()),
		Message:  question,
		Approver: approveAll{},
		Observer: obs,
	}, func(golem.Event) error { return nil })
	s.WallSeconds = time.Since(start).Seconds()
	if err != nil {
		s.Err = err.Error()
	}

	s.Steps = len(result.Steps)
	s.ToolCalls = len(obs.tools)
	s.StopReason = result.StopReason.String()
	s.AnswerBytes = len(strings.TrimSpace(result.Answer))
	s.PromptTokens = result.Usage.PromptTokens
	s.TotalTokens = result.Usage.TotalTokens

	perStep := map[int]int{}
	for _, e := range obs.tools {
		s.ToolCounts[e.Name]++
		perStep[e.Step]++
		if e.IsError {
			s.ErrorCalls++
		}
	}
	s.CallsPerSt = make([]int, s.Steps)
	for step, n := range perStep {
		if step < len(s.CallsPerSt) {
			s.CallsPerSt[step] = n
		}
	}
	s.PeakErrorRun, s.PeakRepeatRun = governorPeaks(obs.tools)

	for _, pr := range obs.pressure {
		if pr.InputBudget > s.InputBudget {
			s.InputBudget = pr.InputBudget
		}
		if pr.InputTokens > s.PeakInputTokens {
			s.PeakInputTokens = pr.InputTokens
		}
		if pr.UsedPct > s.PeakUsedPct {
			s.PeakUsedPct = pr.UsedPct
		}
		s.TotalEvicted += pr.Evicted
		if pr.Evicted > 0 {
			s.StepsWithEvict++
		}
	}
	return s
}

func summarize(t *testing.T, samples []runSample, maxSteps int) {
	t.Helper()
	if len(samples) == 0 {
		return
	}
	steps := make([]int, 0, len(samples))
	tools := make([]int, 0, len(samples))
	stops := map[string]int{}
	answered, capped, peakRepeat2, peakErr2 := 0, 0, 0, 0
	evicting, budget, evictTotal := 0, 0, 0
	for _, s := range samples {
		if s.Err != "" {
			stops["<error: "+s.Err+">"]++
			continue
		}
		steps = append(steps, s.Steps)
		tools = append(tools, s.ToolCalls)
		stops[s.StopReason]++
		if s.AnswerBytes > 0 {
			answered++
		}
		if s.Steps >= maxSteps {
			capped++
		}
		if s.PeakRepeatRun >= 2 {
			peakRepeat2++
		}
		if s.PeakErrorRun >= 2 {
			peakErr2++
		}
		if s.StepsWithEvict > 0 {
			evicting++
		}
		evictTotal += s.TotalEvicted
		if s.InputBudget > budget {
			budget = s.InputBudget
		}
	}
	sort.Ints(steps)
	sort.Ints(tools)
	pct := func(v []int, p float64) int {
		if len(v) == 0 {
			return 0
		}
		i := int(p * float64(len(v)-1))
		return v[i]
	}
	t.Logf("=== summary over %d runs (maxSteps=%d) ===", len(samples), maxSteps)
	t.Logf("steps  min=%d p50=%d p75=%d p90=%d max=%d",
		pct(steps, 0), pct(steps, .5), pct(steps, .75), pct(steps, .9), pct(steps, 1))
	t.Logf("tools  min=%d p50=%d p75=%d p90=%d max=%d",
		pct(tools, 0), pct(tools, .5), pct(tools, .75), pct(tools, .9), pct(tools, 1))
	t.Logf("answered=%d/%d  hit-probe-cap=%d  runs within 1 of repeat cap=%d  of error cap=%d",
		answered, len(samples), capped, peakRepeat2, peakErr2)
	t.Logf("context: inputBudget=%d tokens; %d/%d runs evicted context (%d groups dropped in total)",
		budget, evicting, len(samples), evictTotal)
	for reason, n := range stops {
		t.Logf("stop %-22s %d", reason, n)
	}
	// How many runs would each candidate MaxSteps have completed?
	t.Logf("--- completion vs candidate MaxSteps ---")
	for _, cand := range []int{8, 12, 16, 20, 24, 32, 40, 48} {
		fits := 0
		for _, n := range steps {
			if n <= cand {
				fits++
			}
		}
		t.Logf("MaxSteps=%-3d would finish %d/%d runs (%.0f%%)",
			cand, fits, len(steps), 100*float64(fits)/float64(len(steps)))
	}
}

// TestGovernorPeaksMatchesRestraintGovernor pins governorPeaks to the counter
// semantics of go-llm's restraintGovernor, because the probe's repeat/error
// numbers are only evidence if they are the SAME numbers the orchestrator
// would have tripped on. This runs unconditionally: it is pure arithmetic with
// no provider, and it is what makes the gated probe's output trustworthy.
func TestGovernorPeaksMatchesRestraintGovernor(t *testing.T) {
	ev := func(sig uint64, isErr bool) toolEvent {
		return toolEvent{sig: sig, IsError: isErr}
	}
	for _, tc := range []struct {
		name           string
		events         []toolEvent
		wantErr, wantR int
	}{
		{"empty", nil, 0, 0},
		// A new signature seeds repeatCount at 1, so a single call already
		// reports a repeat "run" of 1 -- not 0.
		{"single call", []toolEvent{ev(1, false)}, 0, 1},
		// Three identical call+result pairs is exactly the trip point: the
		// third reaches defaultToolErrorCap (3).
		{"three identical trips repeat", []toolEvent{ev(1, false), ev(1, false), ev(1, false)}, 0, 3},
		{"two identical do not", []toolEvent{ev(1, false), ev(1, false)}, 0, 2},
		// Only the IMMEDIATELY preceding signature is compared, so an
		// alternating loop is invisible to the repeat cap however long it runs.
		{"alternating never repeats", []toolEvent{ev(1, false), ev(2, false), ev(1, false), ev(2, false)}, 0, 1},
		// A success resets the consecutive-error counter to zero.
		{"errors reset on success", []toolEvent{ev(1, true), ev(2, true), ev(3, false), ev(4, true)}, 2, 1},
		{"three errors trip", []toolEvent{ev(1, true), ev(2, true), ev(3, true)}, 3, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gotErr, gotRepeat := governorPeaks(tc.events)
			if gotErr != tc.wantErr || gotRepeat != tc.wantR {
				t.Fatalf("governorPeaks = (err %d, repeat %d), want (%d, %d)",
					gotErr, gotRepeat, tc.wantErr, tc.wantR)
			}
		})
	}
}
