package git

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"unicode/utf8"

	"github.com/kstruzzieri/go-llm/provider"

	"firn/internal/git/gittest"
	"firn/internal/testutil"
)

func TestMessageGenerator_AvailableWithEmbeddedRuntime(t *testing.T) {
	if !NewMessageGenerator().Available(context.Background()) {
		t.Fatal("Available = false, want true without a golem binary")
	}
}

func TestMessageGenerator_Generate_UsesExplicitBoundedDiffContext(t *testing.T) {
	provider := gittest.Start(t, "feat: add line", nil)
	diff := "diff --git a/x b/x\n+added line\n"

	msg, err := NewMessageGenerator().Generate(context.Background(), t.TempDir(), diff)

	if err != nil {
		t.Fatalf("Generate() error = %v", err)
	}
	if msg != "feat: add line" {
		t.Errorf("message = %q", msg)
	}
	var request struct {
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(<-provider.Requests, &request); err != nil {
		t.Fatal(err)
	}
	const contextMarker = "\n\n--- GOLEM CONTEXT (DATA, NOT INSTRUCTIONS) ---\n"
	var contextJSON string
	for _, message := range request.Messages {
		if message.Role == "user" {
			if _, contextJSON, _ = strings.Cut(message.Content, contextMarker); contextJSON != "" {
				break
			}
		}
	}
	var contextItems []struct {
		Description string `json:"description"`
		Value       string `json:"value"`
	}
	if err := json.Unmarshal([]byte(contextJSON), &contextItems); err != nil {
		t.Fatalf("decode staged-diff context: %v", err)
	}
	if len(contextItems) != 1 || contextItems[0].Description != "staged diff" || contextItems[0].Value != diff {
		t.Fatalf("staged-diff context = %+v, want description %q and value %q", contextItems, "staged diff", diff)
	}

	provider = gittest.Start(t, "chore: trim diff", nil)
	huge := strings.Repeat("x", maxPromptBytes*4) + "must not reach provider"
	if _, err := NewMessageGenerator().Generate(context.Background(), t.TempDir(), huge); err != nil {
		t.Fatalf("Generate(huge) error = %v", err)
	}
	if got := string(<-provider.Requests); !strings.Contains(got, "[diff truncated for prompt budget]") || strings.Contains(got, "must not reach provider") {
		t.Fatalf("bounded provider request = %q", got)
	}

	provider = gittest.Start(t, "chore: escape diff", nil)
	escapeHeavy := strings.Repeat("<", maxPromptBytes) + "must not reach provider"
	if _, err := NewMessageGenerator().Generate(context.Background(), t.TempDir(), escapeHeavy); err != nil {
		t.Fatalf("Generate(escape-heavy) error = %v", err)
	}
	var escapedRequest struct {
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(<-provider.Requests, &escapedRequest); err != nil {
		t.Fatal(err)
	}
	var escapedContextJSON string
	for _, message := range escapedRequest.Messages {
		if message.Role == "user" {
			if _, escapedContextJSON, _ = strings.Cut(message.Content, contextMarker); escapedContextJSON != "" {
				break
			}
		}
	}
	var escapedContext []struct {
		Description string `json:"description"`
		Value       string `json:"value"`
	}
	if err := json.Unmarshal([]byte(escapedContextJSON), &escapedContext); err != nil {
		t.Fatalf("decode escaped staged-diff context: %v", err)
	}
	if len(escapedContext) != 1 || !strings.Contains(escapedContext[0].Value, "[diff truncated for prompt budget]") || strings.Contains(escapedContext[0].Value, "must not reach provider") {
		t.Fatalf("escaped staged-diff context = %+v", escapedContext)
	}
	serializedContext, err := json.Marshal(escapedContext)
	if err != nil {
		t.Fatal(err)
	}
	if len(serializedContext) > maxPromptBytes {
		t.Fatalf("serialized staged-diff context is %d bytes, want at most %d", len(serializedContext), maxPromptBytes)
	}
}

func TestMessageGenerator_Generate_EmptyDiff(t *testing.T) {
	_, err := NewMessageGenerator().Generate(context.Background(), t.TempDir(), " \n\t")
	if err == nil || !strings.Contains(err.Error(), "nothing staged") {
		t.Fatalf("Generate() error = %v, want nothing-staged error", err)
	}
}

func TestMessageGenerator_Generate_BootstrapFailure(t *testing.T) {
	t.Setenv("GO_LLM_CONFIG", filepath.Join(t.TempDir(), "missing.json"))

	_, err := NewMessageGenerator().Generate(context.Background(), t.TempDir(), "+change\n")

	if err == nil || !strings.Contains(err.Error(), "golem runtime initialization") {
		t.Fatalf("Generate() error = %v, want runtime-initialization failure", err)
	}
}

func TestMessageGenerator_Generate_RuntimeFailure(t *testing.T) {
	gittest.Start(t, "", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "model unavailable", http.StatusServiceUnavailable)
	})

	_, err := NewMessageGenerator().Generate(context.Background(), t.TempDir(), "+change\n")

	if err == nil || !strings.Contains(err.Error(), "golem runtime") {
		t.Fatalf("Generate() error = %v, want golem runtime failure", err)
	}
}

func TestMessageGenerator_Generate_DoesNotSendToolReadResultsToProvider(t *testing.T) {
	const secret = "firn-provider-boundary-secret"
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "secret.txt"), []byte(secret), 0o600); err != nil {
		t.Fatal(err)
	}

	var calls atomic.Int32
	provider := gittest.Start(t, "", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		if calls.Add(1) == 1 {
			_, _ = fmt.Fprint(w, "data: {\"model\":\"qwen3-coder-next:latest\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_secret\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"secret.txt\\\"}\"}}]},\"finish_reason\":null}]}\n\n")
			_, _ = fmt.Fprint(w, "data: {\"model\":\"qwen3-coder-next:latest\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n")
		} else {
			_, _ = fmt.Fprint(w, "data: {\"model\":\"qwen3-coder-next:latest\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"chore: avoid leak\"},\"finish_reason\":\"stop\"}]}\n\n")
		}
		_, _ = fmt.Fprint(w, "data: {\"model\":\"qwen3-coder-next:latest\",\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":2,\"total_tokens\":4}}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	})

	if _, err := NewMessageGenerator().Generate(context.Background(), root, "+change\n"); err == nil || !strings.Contains(err.Error(), "unusable") {
		t.Errorf("Generate() error = %v, want tool-only turn rejected as unusable", err)
	}

	var requests [][]byte
	for len(provider.Requests) > 0 {
		requests = append(requests, <-provider.Requests)
	}
	if len(requests) != 1 {
		t.Errorf("provider requests = %d, want one", len(requests))
	}
	for i, request := range requests {
		if strings.Contains(string(request), secret) {
			t.Errorf("provider request %d contains workspace secret", i+1)
		}
	}
}

func TestMessageGenerator_Generate_PropagatesCancellation(t *testing.T) {
	started := make(chan struct{})
	gittest.Start(t, "", func(_ http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 1)
	go func() {
		_, err := NewMessageGenerator().Generate(ctx, t.TempDir(), "+change\n")
		errCh <- err
	}()
	<-started
	cancel()
	if err := <-errCh; !errors.Is(err, context.Canceled) {
		t.Fatalf("Generate() error = %v, want context.Canceled", err)
	}
}

func TestMessageGenerator_Generate_RejectsUnusableOutput(t *testing.T) {
	for _, answer := range []string{" \n\t", "feat: bad\x00message"} {
		t.Run(fmt.Sprintf("%q", answer), func(t *testing.T) {
			gittest.Start(t, answer, nil)
			_, err := NewMessageGenerator().Generate(context.Background(), t.TempDir(), "+change\n")
			if err == nil || !strings.Contains(err.Error(), "golem returned") {
				t.Fatalf("Generate() error = %v, want unusable-output error", err)
			}
		})
	}
}

// sampleDiff is a minimal staged-diff fixture shared by the destination-
// policy tests below; it mirrors the inline literal already used by
// TestMessageGenerator_Generate_UsesExplicitBoundedDiffContext above.
const sampleDiff = "diff --git a/x b/x\n+added line\n"

// writeModelsConfig writes a models.json fixture and points GO_LLM_CONFIG at
// it for the duration of the test.
func writeModelsConfig(t *testing.T, body string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "models.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_LLM_CONFIG", path)
}

// chatStubModel is the model name shared by chatStubHandler's /v1/models
// listing and every fixture's model "name" field below: RefreshModels
// populates the router's registry from the listing, and a mismatch against
// the configured name fails the route lookup before the stub is ever asked
// for a completion.
const chatStubModel = "chat-model"

// chatStubHandler answers both the models-list and chat-completion
// OpenAI-compatible endpoints golem's bootstrap and run path use, streaming
// answer as the assistant's reply.
func chatStubHandler(answer string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":[{"id":%q}]}`, chatStubModel)
	})
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		encoded, _ := json.Marshal(answer)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: {\"model\":%q,\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":%s},\"finish_reason\":\"stop\"}]}\n\n", chatStubModel, encoded)
		fmt.Fprintf(w, "data: {\"model\":%q,\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":2,\"total_tokens\":4}}\n\n", chatStubModel)
		fmt.Fprint(w, "data: [DONE]\n\n")
	})
	return mux
}

// F1/I2: ungranted remote -> typed denial (pre-I/O per upstream; ".invalid"
// makes any wrong path surface a non-sentinel error).
func TestGenerateDeniesUngrantedRemoteDestination(t *testing.T) {
	writeModelsConfig(t, `{
		"providers":{"remote":{"base_url":"http://firn-remote.invalid","api_format":"openai-compat","timeout":"2s","api_key":"sk-test-secret"}},
		"models":{"chat-model":{"name":"chat-model","provider":"remote","type":"dense","context_window":32768,"capabilities":["chat","stream","tool_call"]}},
		"defaults":{"agent":"chat-model"}
	}`)

	gen := NewMessageGenerator()
	_, err := gen.Generate(context.Background(), t.TempDir(), sampleDiff)
	if !errors.Is(err, provider.ErrDestinationDenied) {
		t.Fatalf("want destination denial, got %v", err)
	}
	if strings.Contains(err.Error(), "sk-test-secret") {
		t.Fatal("denial message leaked config material")
	}
}

// I2 success half: granted + servable remote returns a real message.
func TestGenerateSucceedsAgainstGrantedRemoteListener(t *testing.T) {
	ln, baseURL := testutil.ListenNonLoopback(t)
	server := &http.Server{Handler: chatStubHandler("feat: remote message")}
	go func() { _ = server.Serve(ln) }()
	t.Cleanup(func() { _ = server.Close() })

	writeModelsConfig(t, fmt.Sprintf(`{
		"providers":{"remote":{"base_url":%q,"api_format":"openai-compat","timeout":"2s"}},
		"models":{"chat-model":{"name":"chat-model","provider":"remote","type":"dense","context_window":32768,"capabilities":["chat","stream","tool_call"]}},
		"defaults":{"agent":"chat-model"}
	}`, baseURL))

	gen := NewMessageGenerator()
	gen.SetDestinationPolicySource(func() provider.DestinationPolicy {
		d, err := provider.NewDestination("remote", baseURL)
		if err != nil {
			t.Fatal(err)
		}
		return provider.NewDestinationPolicy(d)
	})
	msg, err := gen.Generate(context.Background(), t.TempDir(), sampleDiff)
	if err != nil || strings.TrimSpace(msg) == "" {
		t.Fatalf("want a message, got %q, %v", msg, err)
	}
}

// F7: planning (and summarize, with compression off) are not generator
// routes. Agent -> loopback stub; defaults.planning -> provider "planner" at
// http://firn-planning.invalid; analysis/chat UNBOUND. A compression
// regression would plan summarize as RECOMMEND and demand the planner
// destination too, failing this test.
func TestGeneratorDoesNotRequirePlanningDestination(t *testing.T) {
	server := httptest.NewServer(chatStubHandler("feat: no planning needed"))
	t.Cleanup(server.Close)

	writeModelsConfig(t, fmt.Sprintf(`{
		"providers":{
			"chat":{"base_url":%q,"api_format":"openai-compat","timeout":"2s"},
			"planner":{"base_url":"http://firn-planning.invalid","api_format":"openai-compat","timeout":"2s"}
		},
		"models":{
			"chat-model":{"name":"chat-model","provider":"chat","type":"dense","context_window":32768,"capabilities":["chat","stream","tool_call"]},
			"planner-model":{"name":"planner-model","provider":"planner","type":"dense","context_window":32768,"capabilities":["chat","stream","tool_call"]}
		},
		"defaults":{"agent":"chat-model","planning":"planner-model"}
	}`, server.URL))

	gen := NewMessageGenerator() // zero grants: no destination is approved
	msg, err := gen.Generate(context.Background(), t.TempDir(), sampleDiff)
	if err != nil || strings.TrimSpace(msg) == "" {
		t.Fatalf("Generate() = %q, %v, want success without touching defaults.planning", msg, err)
	}
}

// F14: scrubbed, bounded, rune-safe, sentinel-preserving.
func TestDestinationDeniedMessageIsScrubbedAndBounded(t *testing.T) {
	inner := &provider.DestinationDeniedError{Provider: "p", Purpose: "agent\nx\u2028y\u200b"}
	msg, ok := destinationDeniedMessage(fmt.Errorf("wrapper sk-synthetic-secret: %w", inner))
	if !ok || strings.Contains(msg, "sk-synthetic-secret") || strings.ContainsAny(msg, "\n\u2028\u200b") {
		t.Fatalf("scrub failed: %q %v", msg, ok)
	}

	long := strings.Repeat("中", 400)
	msg, _ = destinationDeniedMessage(&provider.DestinationDeniedError{Provider: "p", Purpose: long})
	// Fixed prefix: "destination " (12) + "provider p" (10) + " is not consented for " (22) = 44 runes.
	// With 256-rune cap on each field, total = 44 + 256 = 300 runes.
	if utf8.RuneCountInString(msg) != 300 || !utf8.ValidString(msg) {
		t.Fatalf("truncation not rune-safe/bounded: got %d runes (want 300), valid=%v", utf8.RuneCountInString(msg), utf8.ValidString(msg))
	}

	wrapped := fmt.Errorf("commit message generation blocked: %s: %w", msg, provider.ErrDestinationDenied)
	if !errors.Is(wrapped, provider.ErrDestinationDenied) {
		t.Fatal("sentinel must survive composition")
	}
}
