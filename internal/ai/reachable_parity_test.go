package ai

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/kstruzzieri/go-llm/config"
	"github.com/kstruzzieri/go-llm/golem"
	"github.com/kstruzzieri/go-llm/provider"

	"firn/internal/testutil"
)

// writeParityConfig writes a models.json fixture and returns its path.
func writeParityConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "models.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// parityStubHandler answers the OpenAI-compatible models-list endpoint that
// RefreshModels calls after admission. The corpus below only exercises
// golem.New (bootstrap), never Run, so no chat-completion endpoint is needed.
func parityStubHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data":[{"id":"stub-model"}]}`)
	})
	return mux
}

// explicitRouteParityConfig: agent -> A only.
func explicitRouteParityConfig(remoteA, _, _ string) string {
	return fmt.Sprintf(`{
		"providers": {
			"A": {"base_url": %q, "api_format": "openai-compat", "timeout": "2s"}
		},
		"models": {
			"agent-model": {"name": "agent-model", "provider": "A", "type": "dense", "context_window": 32768, "capabilities": ["chat", "stream", "tool_call"]}
		},
		"defaults": {"agent": "agent-model"}
	}`, remoteA)
}

// transitiveFallbacksParityConfig: agent -> A, fallback -> B.
func transitiveFallbacksParityConfig(remoteA, remoteB, _ string) string {
	return fmt.Sprintf(`{
		"providers": {
			"A": {"base_url": %q, "api_format": "openai-compat", "timeout": "2s"},
			"B": {"base_url": %q, "api_format": "openai-compat", "timeout": "2s"}
		},
		"models": {
			"agent-model": {"name": "agent-model", "provider": "A", "type": "dense", "context_window": 32768, "capabilities": ["chat", "stream", "tool_call"], "fallbacks": ["fallback-model"]},
			"fallback-model": {"name": "fallback-model", "provider": "B", "type": "dense", "context_window": 32768, "capabilities": ["chat", "stream", "tool_call"]}
		},
		"defaults": {"agent": "agent-model"}
	}`, remoteA, remoteB)
}

// absentAgentBindingParityConfig: no defaults.agent; providers A and B are
// both reachable via the recommendation route (upstream I8).
func absentAgentBindingParityConfig(remoteA, remoteB, _ string) string {
	return fmt.Sprintf(`{
		"providers": {
			"A": {"base_url": %q, "api_format": "openai-compat", "timeout": "2s"},
			"B": {"base_url": %q, "api_format": "openai-compat", "timeout": "2s"}
		},
		"models": {
			"model-a": {"name": "model-a", "provider": "A", "type": "dense", "context_window": 32768, "capabilities": ["chat", "stream", "tool_call"]},
			"model-b": {"name": "model-b", "provider": "B", "type": "dense", "context_window": 32768, "capabilities": ["chat", "stream", "tool_call"]}
		},
		"defaults": {}
	}`, remoteA, remoteB)
}

// sharedDestinationParityConfig: two roles on the SAME provider A; agent ->
// role1, fallback -> role2. Both hops collapse to one destination.
func sharedDestinationParityConfig(remoteA, _, _ string) string {
	return fmt.Sprintf(`{
		"providers": {
			"A": {"base_url": %q, "api_format": "openai-compat", "timeout": "2s"}
		},
		"models": {
			"role1": {"name": "role1-model", "provider": "A", "type": "dense", "context_window": 32768, "capabilities": ["chat", "stream", "tool_call"], "fallbacks": ["role2"]},
			"role2": {"name": "role2-model", "provider": "A", "type": "dense", "context_window": 32768, "capabilities": ["chat", "stream", "tool_call"]}
		},
		"defaults": {"agent": "role1"}
	}`, remoteA)
}

// isolatedPlanningParityConfig: agent -> A; defaults.planning -> C. The
// generator sets DisableCompression, and golem.New never plans a route for
// "planning", so C must never enter the reachable set or the manifest.
func isolatedPlanningParityConfig(remoteA, _, remoteC string) string {
	return fmt.Sprintf(`{
		"providers": {
			"A": {"base_url": %q, "api_format": "openai-compat", "timeout": "2s"},
			"C": {"base_url": %q, "api_format": "openai-compat", "timeout": "2s"}
		},
		"models": {
			"agent-model": {"name": "agent-model", "provider": "A", "type": "dense", "context_window": 32768, "capabilities": ["chat", "stream", "tool_call"]},
			"planning-model": {"name": "planning-model", "provider": "C", "type": "dense", "context_window": 32768, "capabilities": ["chat", "stream", "tool_call"]}
		},
		"defaults": {"agent": "agent-model", "planning": "planning-model"}
	}`, remoteA, remoteC)
}

// F15: the D7 mirror (reachableDestinations) is honest against real golem
// admission. Denial half is pre-I/O (.invalid endpoints are fine — gate.Install
// runs before any provider is constructed). Admission half runs RefreshModels
// against every active provider after admission, so granted cases serve
// stubs on non-loopback listeners (skipped when the host has none).
func TestReachableSetMatchesGolemAdmission(t *testing.T) {
	type fixture struct {
		name       string
		modelsJSON func(remoteA, remoteB, remoteC string) string
	}
	corpus := []fixture{
		{"explicit-route", explicitRouteParityConfig},
		{"transitive-fallbacks", transitiveFallbacksParityConfig},
		{"absent-agent-binding", absentAgentBindingParityConfig},
		{"shared-destination", sharedDestinationParityConfig},
		{"isolated-planning", isolatedPlanningParityConfig},
	}

	for _, tc := range corpus {
		t.Run(tc.name, func(t *testing.T) {
			// --- Denial half -------------------------------------------------
			denyPath := writeParityConfig(t, tc.modelsJSON(
				"http://firn-parity-a.invalid",
				"http://firn-parity-b.invalid",
				"http://firn-parity-c.invalid",
			))
			doc, err := config.LoadDocument(denyPath)
			if err != nil {
				t.Fatalf("LoadDocument: %v", err)
			}
			derived := reachableDestinations(doc.Config())
			if len(derived) == 0 {
				t.Fatal("derived reachable set is empty")
			}
			for _, d := range derived {
				if d.Destination.Classification != "remote" {
					t.Fatalf("fixture destination %q classified %q, want remote", d.Destination.Provider, d.Destination.Classification)
				}
			}
			if tc.name == "isolated-planning" {
				for _, d := range derived {
					if d.Destination.Provider == "C" {
						t.Fatal("isolated-planning: derived must not include the planning-only destination C")
					}
				}
			}

			for i, target := range derived {
				var grants []provider.Destination
				for j, other := range derived {
					if j == i {
						continue
					}
					d, err := provider.NewDestination(other.Destination.Provider, other.Destination.Endpoint)
					if err != nil {
						t.Fatalf("NewDestination(%s): %v", other.Destination.Provider, err)
					}
					grants = append(grants, d)
				}
				policy := provider.NewDestinationPolicy(grants...)
				rt, err := golem.New(context.Background(), golem.Options{
					Root:               t.TempDir(),
					ConfigPath:         denyPath,
					MaxSteps:           1,
					DisableCompression: true,
					DestinationPolicy:  policy,
				})
				if rt != nil {
					_ = rt.Close()
				}
				var denied *provider.DestinationDeniedError
				if !errors.As(err, &denied) {
					t.Fatalf("denying %s: want *provider.DestinationDeniedError, got %v", target.Destination.Provider, err)
				}
				if !errors.Is(err, provider.ErrDestinationDenied) {
					t.Fatalf("denying %s: errors.Is(err, ErrDestinationDenied) = false", target.Destination.Provider)
				}
				if got := denied.Destination.Provider(); got != target.Destination.Provider {
					t.Fatalf("denial names %q, want %q", got, target.Destination.Provider)
				}
			}

			// --- Admission half ------------------------------------------------
			// One non-loopback listener per derived remote (skips the whole
			// subtest when the host has none — testutil.ListenNonLoopback).
			listeners := map[string]string{}
			for _, d := range derived {
				ln, baseURL := testutil.ListenNonLoopback(t)
				server := &http.Server{Handler: parityStubHandler()}
				go func() { _ = server.Serve(ln) }()
				t.Cleanup(func() { _ = server.Close() })
				listeners[d.Destination.Provider] = baseURL
			}
			admitPath := writeParityConfig(t, tc.modelsJSON(
				listeners["A"], listeners["B"], "http://firn-parity-c.invalid",
			))

			admitDoc, err := config.LoadDocument(admitPath)
			if err != nil {
				t.Fatalf("LoadDocument (admission): %v", err)
			}
			admitDerived := reachableDestinations(admitDoc.Config())
			grants := make([]provider.Destination, 0, len(admitDerived))
			for _, d := range admitDerived {
				dest, err := provider.NewDestination(d.Destination.Provider, d.Destination.Endpoint)
				if err != nil {
					t.Fatalf("NewDestination(%s): %v", d.Destination.Provider, err)
				}
				grants = append(grants, dest)
			}
			rt, err := golem.New(context.Background(), golem.Options{
				Root:               t.TempDir(),
				ConfigPath:         admitPath,
				MaxSteps:           1,
				DisableCompression: true,
				DestinationPolicy:  provider.NewDestinationPolicy(grants...),
			})
			if err != nil {
				t.Fatalf("golem.New with full grant: %v", err)
			}
			if err := rt.Close(); err != nil {
				t.Fatalf("Close: %v", err)
			}
		})
	}
}
