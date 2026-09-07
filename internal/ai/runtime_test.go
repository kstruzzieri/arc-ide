package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"firn/internal/filesystem"
	"github.com/kstruzzieri/go-llm/config"
	"github.com/kstruzzieri/go-llm/golem"
	"github.com/kstruzzieri/go-llm/provider"
)

// scriptedProvider is a fake concrete backend. Each ChatStream call consumes
// one scripted step (a tool call or a final answer), streamed in chunks the
// way real providers stream, stamped with the configured instance name. Every
// other Provider method counts as unexpected: the runner must never route,
// probe health, or list models.
type scriptedProvider struct {
	name string
	err  error // non-nil: every ChatStream fails with this raw error

	mu         sync.Mutex
	requests   []provider.ChatRequest
	steps      []provider.ChatResponse
	stepIdx    int
	unexpected int32
}

func (p *scriptedProvider) Name() string { return p.name }
func (p *scriptedProvider) Capabilities() provider.Capability {
	return provider.CapChat | provider.CapStream | provider.CapToolCall
}

func (p *scriptedProvider) unexpectedCall(what string) error {
	atomic.AddInt32(&p.unexpected, 1)
	return errors.New("scripted provider: unexpected " + what + " call")
}

func (p *scriptedProvider) Health(context.Context) error { return p.unexpectedCall("Health") }
func (p *scriptedProvider) Models(context.Context) ([]provider.ModelInfo, error) {
	return nil, p.unexpectedCall("Models")
}
func (p *scriptedProvider) Chat(context.Context, provider.ChatRequest) (*provider.ChatResponse, error) {
	return nil, p.unexpectedCall("Chat")
}
func (p *scriptedProvider) Generate(context.Context, provider.GenerateRequest) (*provider.GenerateResponse, error) {
	return nil, p.unexpectedCall("Generate")
}
func (p *scriptedProvider) GenerateStream(context.Context, provider.GenerateRequest, func(provider.GenerateResponse) error) error {
	return p.unexpectedCall("GenerateStream")
}
func (p *scriptedProvider) Embed(context.Context, provider.EmbedRequest) (*provider.EmbedResponse, error) {
	return nil, p.unexpectedCall("Embed")
}

func (p *scriptedProvider) ChatStream(_ context.Context, req provider.ChatRequest, fn func(provider.ChatResponse) error) error {
	p.mu.Lock()
	p.requests = append(p.requests, req)
	if p.err != nil {
		p.mu.Unlock()
		return p.err
	}
	if p.stepIdx >= len(p.steps) {
		p.mu.Unlock()
		return errors.New("scripted provider: script exhausted")
	}
	step := p.steps[p.stepIdx]
	p.stepIdx++
	p.mu.Unlock()

	if step.Content != "" {
		half := len(step.Content) / 2
		for _, chunk := range []string{step.Content[:half], step.Content[half:]} {
			if err := fn(provider.ChatResponse{Model: req.Model, Provider: p.name, Content: chunk}); err != nil {
				return err
			}
		}
	}
	return fn(provider.ChatResponse{Model: req.Model, Provider: p.name, ToolCalls: step.ToolCalls, Done: true})
}

func (p *scriptedProvider) recorded() []provider.ChatRequest {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]provider.ChatRequest(nil), p.requests...)
}

func scriptedToolCall(id, name, args string) provider.ChatResponse {
	return provider.ChatResponse{ToolCalls: []provider.ToolCall{{
		ID:       id,
		Type:     "function",
		Function: provider.ToolCallFunction{Name: name, Arguments: json.RawMessage(args)},
	}}}
}

type approveAll struct{}

func (approveAll) Approve(context.Context, provider.ToolCall, string) (bool, error) {
	return true, nil
}

func testTarget(providerKey, modelName string) providerTarget {
	return providerTarget{
		destination: ProviderDestination{
			Provider:       providerKey,
			Model:          modelName,
			Endpoint:       "http://127.0.0.1:1",
			Classification: "local",
		},
		apiFormat: "ollama",
		timeout:   5 * time.Second,
		model:     config.ModelConfig{Name: modelName, Provider: providerKey},
	}
}

func canonicalTempDir(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}
	return root
}

// ---------------------------------------------------------------------------
// B4.2 — direct caller
// ---------------------------------------------------------------------------

func TestFixedModelCallerStampsDestinationAndFillsDefaults(t *testing.T) {
	target := testTarget("hosted", "big-coder")
	target.model.Options = &config.SamplingOptions{
		Temperature: provider.Ptr(0.2),
		TopP:        provider.Ptr(0.9),
		TopK:        provider.Ptr(40),
	}
	mode := provider.ThinkToggle
	target.thinkMode = &mode
	target.thinkTags = &provider.ThinkTags{Open: "<reason>", Close: "</reason>"}

	backend := &scriptedProvider{name: "hosted", steps: []provider.ChatResponse{{Content: "hello world"}}}
	caller := &fixedModelCaller{backend: backend, target: target}

	var chunks []provider.ChatResponse
	res, err := caller.Chat(context.Background(), provider.ChatRequest{
		Model:    "router-picked-wrong-model",
		Provider: "router-routing-metadata",
		Messages: []provider.ChatMessage{{Role: "user", Content: "hi"}},
		Options:  provider.ModelOptions{TopP: provider.Ptr(0.5)},
		Stream:   true,
	}, func(c provider.ChatResponse) error {
		chunks = append(chunks, c)
		return nil
	})
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}

	reqs := backend.recorded()
	if len(reqs) != 1 {
		t.Fatalf("backend requests = %d, want 1", len(reqs))
	}
	sent := reqs[0]
	if sent.Model != "big-coder" {
		t.Fatalf("Model = %q, want the fixed destination model", sent.Model)
	}
	if sent.Provider != "" {
		t.Fatalf("Provider = %q, want routing metadata cleared before the concrete provider", sent.Provider)
	}
	if sent.Options.Temperature == nil || *sent.Options.Temperature != 0.2 {
		t.Fatalf("Temperature = %v, want configured default 0.2 filling the nil field", sent.Options.Temperature)
	}
	if sent.Options.TopP == nil || *sent.Options.TopP != 0.5 {
		t.Fatalf("TopP = %v, want the request's own 0.5 preserved over the default", sent.Options.TopP)
	}
	if sent.Options.TopK == nil || *sent.Options.TopK != 40 {
		t.Fatalf("TopK = %v, want configured default 40", sent.Options.TopK)
	}
	if sent.ParseThinkMode == nil || *sent.ParseThinkMode != provider.ThinkToggle {
		t.Fatalf("ParseThinkMode = %v, want the target's toggle mode", sent.ParseThinkMode)
	}
	if sent.ParseThinkTags == nil || sent.ParseThinkTags.Open != "<reason>" || sent.ParseThinkTags.Close != "</reason>" {
		t.Fatalf("ParseThinkTags = %+v, want the target's tags", sent.ParseThinkTags)
	}

	if len(chunks) < 3 {
		t.Fatalf("streamed chunks = %d, want content chunks plus the final chunk via provider.Collect", len(chunks))
	}
	for i, c := range chunks {
		if c.Provider != "hosted" {
			t.Fatalf("chunk %d Provider = %q, want the configured instance name %q", i, c.Provider, "hosted")
		}
	}
	if res.Response.Content != "hello world" || !res.Response.Done {
		t.Fatalf("final response = %+v, want Collect-aggregated content", res.Response)
	}
	if res.Response.Provider != "hosted" {
		t.Fatalf("final Provider = %q, want %q", res.Response.Provider, "hosted")
	}

	want := provider.ModelKey{Provider: "hosted", Model: "big-coder"}
	outcome := res.RouteOutcome
	if outcome == nil || outcome.PlannedModel != want || outcome.ActualModel != want {
		t.Fatalf("RouteOutcome = %+v, want planned and actual both %v", outcome, want)
	}
	if outcome.FallbacksUsed != 0 || len(outcome.Attempts) != 0 {
		t.Fatalf("RouteOutcome represents fallbacks: %+v", outcome)
	}
	if res.Response.RouteOutcome != outcome {
		t.Fatalf("final response RouteOutcome = %+v, want the same fixed outcome", res.Response.RouteOutcome)
	}
	if got := atomic.LoadInt32(&backend.unexpected); got != 0 {
		t.Fatalf("unexpected provider calls = %d (Health/Models/route probes are forbidden)", got)
	}
}

func TestFixedModelCallerReturnsRawProviderError(t *testing.T) {
	raw := errors.New("dial tcp: connection refused (endpoint http://10.0.0.9)")
	backend := &scriptedProvider{name: "hosted", err: raw}
	caller := &fixedModelCaller{backend: backend, target: testTarget("hosted", "big-coder")}
	_, err := caller.Chat(context.Background(), provider.ChatRequest{
		Messages: []provider.ChatMessage{{Role: "user", Content: "hi"}},
	}, nil)
	if !errors.Is(err, raw) {
		t.Fatalf("Chat error = %v, want the provider's raw error kept intact for host logging", err)
	}
}

// ---------------------------------------------------------------------------
// B4.3 — runtime contracts
// ---------------------------------------------------------------------------

func collectSink(events *[]golem.Event) golem.EventSink {
	return func(e golem.Event) error {
		*events = append(*events, e)
		return nil
	}
}

func marshalEvents(t *testing.T, events []golem.Event) string {
	t.Helper()
	var b strings.Builder
	for _, e := range events {
		raw, err := json.Marshal(e)
		if err != nil {
			t.Fatalf("marshal event %s: %v", e.Type, err)
		}
		b.Write(raw)
		b.WriteByte('\n')
	}
	return b.String()
}

func TestGolemRuntimePublicRunFailureMessage(t *testing.T) {
	cases := []struct {
		code string
		want string
	}{
		{"run_conflict", "A Golem run is already active."},
		{"runtime_closed", "Golem is shutting down."},
		{"invalid_request", "The Golem request is invalid."},
		{"provider_unavailable", "The model provider is unavailable."},
		{"observer_failed", "The Golem run failed."},
		{"internal", "The Golem run failed."},
		{"some_future_code", "The Golem run failed."},
	}
	leaky := errors.New("secret endpoint http://10.0.0.9 key sk-leak path /home/user/models.json")
	for _, tc := range cases {
		got := publicRunFailureMessage(tc.code, leaky)
		if got != tc.want {
			t.Fatalf("publicRunFailureMessage(%q) = %q, want %q", tc.code, got, tc.want)
		}
		if strings.Contains(got, tc.code) || strings.Contains(got, "sk-leak") || strings.Contains(got, "10.0.0.9") {
			t.Fatalf("publicRunFailureMessage(%q) leaks input: %q", tc.code, got)
		}
	}
}

func TestGolemRuntimeToolSchemaAndNoSessionDB(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "xdg-data")
	t.Setenv("XDG_DATA_HOME", dataDir)
	root := canonicalTempDir(t)

	backend := &scriptedProvider{name: "hosted", steps: []provider.ChatResponse{{Content: "done"}}}
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
		ThreadID: "thread-1",
		RunID:    "run-1",
		Message:  "hi",
		Approver: approveAll{},
	}, collectSink(&events))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Answer != "done" {
		t.Fatalf("Answer = %q", result.Answer)
	}

	reqs := backend.recorded()
	if len(reqs) == 0 {
		t.Fatal("no model request recorded")
	}
	var names []string
	for _, tool := range reqs[0].Tools {
		names = append(names, tool.Function.Name)
	}
	sort.Strings(names)
	if got, want := strings.Join(names, ","), "glob,list,read_file,search"; got != want {
		t.Fatalf("model-facing tool schema = %q, want exactly %q", got, want)
	}

	for _, dir := range []string{root, dataDir} {
		err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return nil // dataDir may not exist at all
			}
			if !d.IsDir() && d.Name() == "sessions.db" {
				t.Fatalf("found sessions.db at %s: injected SessionStore must prevent the default database", path)
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", dir, err)
		}
	}
	if got := atomic.LoadInt32(&backend.unexpected); got != 0 {
		t.Fatalf("unexpected provider calls = %d", got)
	}
}

func TestGolemRuntimeScopeGuardBlocksSensitivePaths(t *testing.T) {
	const (
		credMarker   = "NEVER-LEAK-CREDENTIAL-AKIAFIRNTEST"
		gitdirMarker = "NEVER-LEAK-GITDIR-/abs/elsewhere/worktrees/wt"
		leakPrefix   = "NEVER-LEAK"
	)
	root := canonicalTempDir(t)
	writeTestFile := func(rel, content string) {
		t.Helper()
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeTestFile("README.md", "public readme content")
	writeTestFile(".env", leakPrefix+"-ENV api_key="+credMarker)
	writeTestFile(".git/config", "[credential]\n\thelper = "+credMarker+"\n")
	writeTestFile(".git/HEAD", "ref: refs/heads/main")
	writeTestFile("wt/.git", "gitdir: "+gitdirMarker)
	writeTestFile(".agent/notes.txt", leakPrefix+"-AGENT")
	writeTestFile("secrets/token.txt", leakPrefix+"-SECRETS")
	writeTestFile("vault/key.txt", leakPrefix+"-VAULT")
	writeTestFile("ai-kit.yaml", "sensitive_paths:\n  - \"secrets/**\"\n  - \"vault/**\"\n")

	policy := LoadScopePolicy(filesystem.NewOS(), root)
	guard := policy.Guard("")

	backend := &scriptedProvider{name: "hosted", steps: []provider.ChatResponse{
		scriptedToolCall("c1", "glob", `{"pattern":"**"}`),
		scriptedToolCall("c2", "list", `{}`),
		scriptedToolCall("c3", "read_file", `{"path":".env"}`),
		scriptedToolCall("c4", "read_file", `{"path":".git/config"}`),
		scriptedToolCall("c5", "read_file", `{"path":"README.md"}`),
		scriptedToolCall("c6", "read_file", `{"path":"wt/.git"}`),
		scriptedToolCall("c7", "read_file", `{"path":".agent/notes.txt"}`),
		scriptedToolCall("c8", "search", `{"pattern":"NEVER-LEAK"}`),
		scriptedToolCall("c9", "read_file", `{"path":"secrets/token.txt"}`),
		scriptedToolCall("c10", "read_file", `{"path":"vault/key.txt"}`),
		{Content: "done"},
	}}
	runner, err := newGolemRunner(context.Background(), root, testTarget("hosted", "big-coder"), guard,
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
		RunID:    "run-scope",
		Message:  "inspect the repo",
		Approver: approveAll{}, // always approves; guard denial must still hold below approval
	}, collectSink(&events))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Answer != "done" {
		t.Fatalf("Answer = %q, want the full script to finish", result.Answer)
	}

	reqs := backend.recorded()
	last := reqs[len(reqs)-1]
	var observations []string
	for _, msg := range last.Messages {
		if msg.Role == "tool" {
			observations = append(observations, msg.Content)
		}
	}
	if len(observations) != 10 {
		t.Fatalf("tool observations = %d, want 10:\n%q", len(observations), observations)
	}

	globOut, listOut, searchOut := observations[0], observations[1], observations[7]
	for _, denied := range []string{".env", ".git", ".agent", "secrets", "vault"} {
		if strings.Contains(globOut, denied) {
			t.Fatalf("glob output lists denied path %q:\n%s", denied, globOut)
		}
		if strings.Contains(listOut, denied) {
			t.Fatalf("list output lists denied path %q:\n%s", denied, listOut)
		}
	}
	if !strings.Contains(globOut, "README.md") {
		t.Fatalf("glob output misses allowed file:\n%s", globOut)
	}
	if searchOut != "no matches" {
		t.Fatalf("search read denied content: %q", searchOut)
	}
	if observations[4] != "public readme content" {
		t.Fatalf("allowed read = %q, want the README content", observations[4])
	}
	for _, i := range []int{2, 3, 5, 6, 8, 9} {
		if observations[i] != "path denied by workspace policy" {
			t.Fatalf("observation %d = %q, want the fixed sanitized denial", i, observations[i])
		}
	}

	// Neither the model transcript nor the raw event stream may carry any
	// protected content.
	for i, req := range reqs {
		for _, msg := range req.Messages {
			if strings.Contains(msg.Content, leakPrefix) {
				t.Fatalf("model request %d leaks protected content: %q", i, msg.Content)
			}
		}
	}
	rawEvents := marshalEvents(t, events)
	for _, marker := range []string{leakPrefix, credMarker, gitdirMarker} {
		if strings.Contains(rawEvents, marker) {
			t.Fatalf("event stream leaks %q:\n%s", marker, rawEvents)
		}
	}
	if got := atomic.LoadInt32(&backend.unexpected); got != 0 {
		t.Fatalf("unexpected provider calls = %d", got)
	}
}

func TestGolemRuntimeRunFailedRedactsProviderFailure(t *testing.T) {
	rootParent := t.TempDir()
	root := filepath.Join(rootParent, "canonical-root-marker")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	const (
		cfgMarker = "/home/user/.config/go-llm/config-path-marker.json"
		keyMarker = "sk-firn-api-key-marker"
	)
	provErr := fmt.Errorf("chat failed: root=%s config=%s authorization=%s", root, cfgMarker, keyMarker)

	target := testTarget("hosted", "big-coder")
	target.apiKey = keyMarker
	backend := &scriptedProvider{name: "hosted", err: provErr}
	runner, err := newGolemRunner(context.Background(), root, target, nil, NewMemorySessionStore(), backend, nil)
	if err != nil {
		t.Fatalf("newGolemRunner: %v", err)
	}
	defer func() { _ = runner.Close() }()

	var events []golem.Event
	_, runErr := runner.Run(context.Background(), golem.Turn{RunID: "run-fail", Message: "hi"}, collectSink(&events))
	if runErr == nil {
		t.Fatal("Run succeeded, want the provider failure")
	}
	// The raw error stays available to the host for logging...
	for _, marker := range []string{root, cfgMarker, keyMarker} {
		if !strings.Contains(runErr.Error(), marker) {
			t.Fatalf("host error lost detail %q: %v", marker, runErr)
		}
	}
	// ...while the event stream carries only the fixed code and message.
	var failed *golem.Event
	for i := range events {
		if events[i].Type == "run.failed" {
			failed = &events[i]
		}
	}
	if failed == nil {
		t.Fatalf("no run.failed event in %s", marshalEvents(t, events))
	}
	var payload struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(failed.Payload, &payload); err != nil {
		t.Fatalf("decode run.failed: %v", err)
	}
	if payload.Code != "internal" || payload.Message != "The Golem run failed." {
		t.Fatalf("run.failed payload = %+v, want the fixed code and message", payload)
	}
	rawEvents := marshalEvents(t, events)
	for _, marker := range []string{root, cfgMarker, keyMarker} {
		if strings.Contains(rawEvents, marker) {
			t.Fatalf("event stream leaks %q:\n%s", marker, rawEvents)
		}
	}
}

type countingListener struct {
	net.Listener
	conns *int32
}

func (l countingListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err == nil {
		atomic.AddInt32(l.conns, 1)
	}
	return c, err
}

func TestGolemRuntimeResolveRemoteTargetMakesZeroRequests(t *testing.T) {
	ln, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	var conns, requests int32
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requests, 1)
	})}
	go func() { _ = srv.Serve(countingListener{Listener: ln, conns: &conns}) }()
	defer func() { _ = srv.Close() }()

	endpoint := fmt.Sprintf("http://0.0.0.0:%d", ln.Addr().(*net.TCPAddr).Port)
	cfg := loadFixtureConfig(t, fmt.Sprintf(`{
  "providers": {"zero": {"base_url": %q, "api_format": "openai-compat"}},
  "models": {"agent-m": {"name": "wire-model", "provider": "zero", "type": "dense", "capabilities": ["chat", "stream", "tool_call"]}},
  "defaults": {"agent": "agent-m"}
}`, endpoint))

	target, err := ResolveAgentTarget(cfg)
	if err != nil {
		t.Fatalf("ResolveAgentTarget: %v", err)
	}
	if target.destination.Classification != "remote" {
		t.Fatalf("Classification = %q, want remote for 0.0.0.0", target.destination.Classification)
	}
	// Resolution alone — no provider, no runtime — must not touch the network.
	if c, r := atomic.LoadInt32(&conns), atomic.LoadInt32(&requests); c != 0 || r != 0 {
		t.Fatalf("resolving the target dialed the destination: conns=%d requests=%d", c, r)
	}
}

func TestGolemRuntimeTransportIgnoresEnvProxy(t *testing.T) {
	var proxied int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&proxied, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer proxy.Close()
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("HTTPS_PROXY", proxy.URL)
	t.Setenv("ALL_PROXY", proxy.URL)
	t.Setenv("NO_PROXY", "")

	// A non-loopback hostname: the default ProxyFromEnvironment WOULD send
	// this through the proxy; the hardened transport must dial direct (and
	// fail on the reserved .invalid name) instead.
	target := testTarget("hosted", "big-coder")
	target.destination.Endpoint = "http://firn-proxy-canary.invalid:9"
	backend, transport, err := buildProvider(target)
	if err != nil {
		t.Fatalf("buildProvider: %v", err)
	}
	defer transport.CloseIdleConnections()
	if transport.Proxy != nil {
		t.Fatal("transport.Proxy != nil: environment proxies would be honored")
	}
	_, chatErr := backend.Chat(context.Background(), provider.ChatRequest{
		Model:    "big-coder",
		Messages: []provider.ChatMessage{{Role: "user", Content: "hi"}},
	})
	if chatErr == nil {
		t.Fatal("Chat to .invalid succeeded, something answered")
	}
	if got := atomic.LoadInt32(&proxied); got != 0 {
		t.Fatalf("proxy received %d request(s); environment proxy must be ignored", got)
	}
}

func TestGolemRuntimeTransportRefusesRedirects(t *testing.T) {
	var remoteHits int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&remoteHits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer remote.Close()

	for _, code := range []int{http.StatusTemporaryRedirect, http.StatusPermanentRedirect} {
		local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Location", remote.URL)
			w.WriteHeader(code)
		}))
		target := testTarget("hosted", "big-coder")
		target.destination.Endpoint = local.URL
		target.apiFormat = "openai-compat"
		backend, transport, err := buildProvider(target)
		if err != nil {
			t.Fatalf("buildProvider: %v", err)
		}
		_, chatErr := backend.Chat(context.Background(), provider.ChatRequest{
			Model:    "big-coder",
			Messages: []provider.ChatMessage{{Role: "user", Content: "hi"}},
		})
		if chatErr == nil {
			t.Fatalf("Chat through a %d redirect succeeded, want an error", code)
		}
		if got := atomic.LoadInt32(&remoteHits); got != 0 {
			t.Fatalf("redirect target received %d request(s) after a %d; consented destination changed", got, code)
		}
		transport.CloseIdleConnections()
		local.Close()
	}
}

func TestGolemRuntimeBuildProviderUsesConfiguredInstanceName(t *testing.T) {
	for _, format := range []string{"ollama", "openai-compat"} {
		target := testTarget("hosted", "big-coder")
		target.apiFormat = format
		backend, transport, err := buildProvider(target)
		if err != nil {
			t.Fatalf("buildProvider(%s): %v", format, err)
		}
		transport.CloseIdleConnections()
		if backend.Name() != "hosted" {
			t.Fatalf("buildProvider(%s).Name() = %q, want the configured key %q, never the format default", format, backend.Name(), "hosted")
		}
	}
	target := testTarget("hosted", "big-coder")
	target.apiFormat = "grpc-exotic"
	if _, _, err := buildProvider(target); err == nil {
		t.Fatal("buildProvider accepted an unsupported api format")
	}
}

func TestGolemRuntimeCloseClosesIdleConnections(t *testing.T) {
	var closed int32
	backendSrv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/x-ndjson")
		_, _ = io.WriteString(w, `{"model":"big-coder","message":{"role":"assistant","content":"done"},"done":false}`+"\n")
		_, _ = io.WriteString(w, `{"model":"big-coder","message":{"role":"assistant","content":""},"done":true}`+"\n")
	}))
	backendSrv.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateClosed {
			atomic.AddInt32(&closed, 1)
		}
	}
	backendSrv.Start()
	defer backendSrv.Close()

	root := canonicalTempDir(t)
	target := testTarget("hosted", "big-coder")
	target.destination.Endpoint = backendSrv.URL
	runner, err := NewGolemRunner(context.Background(), root, target, nil, NewMemorySessionStore())
	if err != nil {
		t.Fatalf("NewGolemRunner: %v", err)
	}

	result, err := runner.Run(context.Background(), golem.Turn{RunID: "run-close", Message: "hi"},
		func(golem.Event) error { return nil })
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Answer != "done" {
		t.Fatalf("Answer = %q", result.Answer)
	}

	if err := runner.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for atomic.LoadInt32(&closed) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("keep-alive connection still open after Close; owned transport must close idle connections")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Close is idempotent: a second Close returns without panic or deadlock
	// (golem.Runtime.Close is idempotent; pin the wrapper too).
	if err := runner.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}
