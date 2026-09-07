package ai

import (
	"context"
	"fmt"
	"net/http"

	"github.com/kstruzzieri/go-llm/agent"
	agenttools "github.com/kstruzzieri/go-llm/agent/tools"
	"github.com/kstruzzieri/go-llm/golem"
	"github.com/kstruzzieri/go-llm/ollama"
	"github.com/kstruzzieri/go-llm/provider"
	"github.com/kstruzzieri/go-llm/provider/openaicompat"
)

// Runner is the narrow runtime surface B5's service drives.
type Runner interface {
	Run(context.Context, golem.Turn, golem.EventSink) (agent.Result, error)
	Cancel(string) bool
	Close() error
}

// golemRunner owns one golem.Runtime and the HTTP transport its single
// concrete provider dials through.
type golemRunner struct {
	runtime   *golem.Runtime
	transport *http.Transport
}

// NewGolemRunner builds the direct one-provider Golem runtime rooted at root.
//
// root and guard must describe the same workspace: the caller passes the
// identity layer's canonical ToolRoot (already EvalSymlinks'd, so golem's own
// root canonicalization is a fixed point) together with
// ScopePolicy.Guard(WorkspaceRel), where WorkspaceRel is the repo-relative
// slash path of that workspace. If a workspace subdir were a symlink whose
// resolution escaped the lexical join repoRoot/WorkspaceRel, B1's Resolve
// already rejected it, so the guard's prefix mapping and the runtime's
// resolved Root cannot diverge here.
func NewGolemRunner(
	ctx context.Context,
	root string,
	target providerTarget,
	guard agenttools.ScopeGuard,
	sessions golem.SessionStore,
) (Runner, error) {
	backend, transport, err := buildProvider(target)
	if err != nil {
		return nil, err
	}
	return newGolemRunner(ctx, root, target, guard, sessions, backend, transport)
}

// newGolemRunner is the backend injection seam shared by NewGolemRunner and
// the tests that script a fake concrete provider (transport nil there).
func newGolemRunner(
	ctx context.Context,
	root string,
	target providerTarget,
	guard agenttools.ScopeGuard,
	sessions golem.SessionStore,
	backend provider.Provider,
	transport *http.Transport,
) (Runner, error) {
	orchestrator := agent.New(
		&fixedModelCaller{backend: backend, target: target},
		agent.ContextManager{},
	)
	runtime, err := golem.New(ctx, golem.Options{
		Root:               root,
		ScopeGuard:         guard,
		Orchestrator:       orchestrator,
		SessionStore:       sessions,
		DisableCompression: true,
		RetainReasoning:    false,
		MaxMessageBytes:    MaxTurnMessageBytes,
		FailureMessage:     publicRunFailureMessage,
	})
	if err != nil {
		return nil, err
	}
	return &golemRunner{runtime: runtime, transport: transport}, nil
}

func (r *golemRunner) Run(ctx context.Context, turn golem.Turn, sink golem.EventSink) (agent.Result, error) {
	return r.runtime.Run(ctx, turn, sink)
}

func (r *golemRunner) Cancel(runID string) bool { return r.runtime.Cancel(runID) }

// Close shuts down the runtime first (canceling and waiting out active runs),
// then drops the owned transport's idle connections.
func (r *golemRunner) Close() error {
	err := r.runtime.Close()
	if r.transport != nil {
		r.transport.CloseIdleConnections()
	}
	return err
}

// buildProvider constructs the single concrete backend for the already-
// validated target using the public constructors only — no router, no health
// probe, no Models call, no network I/O. The returned transport is host-owned
// and hardened so nothing can silently change the consented destination:
// environment proxies are ignored and provider redirects are never followed.
func buildProvider(target providerTarget) (provider.Provider, *http.Transport, error) {
	transport, ok := http.DefaultTransport.(*http.Transport)
	if ok {
		transport = transport.Clone()
	} else {
		// A dependency replaced http.DefaultTransport with something else;
		// start from a fresh transport instead of panicking on the assertion.
		transport = &http.Transport{}
	}
	transport.Proxy = nil
	client := &http.Client{
		Transport: transport,
		Timeout:   target.timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	switch target.apiFormat {
	case "ollama":
		backend := ollama.NewClient(
			ollama.WithBaseURL(target.destination.Endpoint),
			ollama.WithHTTPClient(client),
		)
		return provider.NewOllamaProvider(backend, provider.WithProviderName(target.destination.Provider)), transport, nil
	case "openai-compat":
		backend := openaicompat.NewClient(
			target.destination.Endpoint,
			openaicompat.WithHTTPClient(client),
			openaicompat.WithAPIKey(target.apiKey),
		)
		return openaicompat.NewProvider(backend, openaicompat.WithProviderName(target.destination.Provider)), transport, nil
	default:
		return nil, nil, fmt.Errorf("%w: unsupported provider api format", ErrAgentConfigInvalid)
	}
}

// fixedModelCaller sends every model call straight to the one consented
// destination. There is no router and no fallback chain, so the route outcome
// always names the fixed target.
type fixedModelCaller struct {
	backend provider.Provider
	target  providerTarget
}

func (c *fixedModelCaller) Chat(
	ctx context.Context,
	req provider.ChatRequest,
	onToken func(provider.ChatResponse) error,
) (agent.ModelResult, error) {
	req.Model = c.target.model.Name
	req.Provider = "" // router selection metadata; the backend already is the selected instance
	if o := c.target.model.Options; o != nil {
		if req.Options.Temperature == nil {
			req.Options.Temperature = o.Temperature
		}
		if req.Options.TopP == nil {
			req.Options.TopP = o.TopP
		}
		if req.Options.TopK == nil {
			req.Options.TopK = o.TopK
		}
	}
	if req.ParseThinkMode == nil {
		req.ParseThinkMode = c.target.thinkMode
	}
	if req.ParseThinkTags == nil {
		req.ParseThinkTags = c.target.thinkTags
	}
	key := provider.ModelKey{Provider: c.target.destination.Provider, Model: c.target.model.Name}
	outcome := &provider.RouteOutcome{PlannedModel: key, ActualModel: key}
	wrapped, getFinal := provider.Collect(onToken)
	err := c.backend.ChatStream(ctx, req, wrapped)
	final := getFinal()
	final.RouteOutcome = outcome
	// The concrete provider's error stays intact for host logging;
	// publicRunFailureMessage is the presentation boundary.
	return agent.ModelResult{Response: final, RouteOutcome: outcome}, err
}

// publicRunFailureMessage is the presentation boundary for run.failed events.
// It ignores err entirely: no code, endpoint, provider response, or error
// text ever reaches the payload. Run still returns the raw error to the host.
func publicRunFailureMessage(code string, _ error) string {
	switch code {
	case "run_conflict":
		return "A Golem run is already active."
	case "runtime_closed":
		return "Golem is shutting down."
	case "invalid_request":
		return "The Golem request is invalid."
	case "provider_unavailable":
		return "The model provider is unavailable."
	default: // observer_failed, internal, and anything unknown collapse
		return "The Golem run failed."
	}
}
