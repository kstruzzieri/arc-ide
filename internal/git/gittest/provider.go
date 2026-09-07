// Package gittest provides a fake OpenAI-compatible provider for tests that
// exercise the embedded golem runtime.
package gittest

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// Model is the model name the fake provider serves and its config declares.
const Model = "qwen3-coder-next:latest"

// Provider is a fake OpenAI-compatible chat endpoint wired to golem via
// GO_LLM_CONFIG. Requests receives each /v1/chat/completions request body.
type Provider struct {
	Requests chan []byte
}

// Start serves answer as a streamed chat completion for every chat request —
// or delegates to chat when it is non-nil — and points GO_LLM_CONFIG at a
// config naming the server. The server and env var are undone on test cleanup.
func Start(t *testing.T, answer string, chat func(http.ResponseWriter, *http.Request)) *Provider {
	t.Helper()
	provider := &Provider{Requests: make(chan []byte, 4)}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprintf(w, `{"data":[{"id":%q}]}`, Model)
		case "/v1/chat/completions":
			body, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			provider.Requests <- body
			if chat != nil {
				chat(w, r)
				return
			}
			encoded, err := json.Marshal(answer)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = fmt.Fprintf(w, "data: {\"model\":%q,\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":%s},\"finish_reason\":\"stop\"}]}\n\n", Model, encoded)
			_, _ = fmt.Fprintf(w, "data: {\"model\":%q,\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":2,\"total_tokens\":4}}\n\n", Model)
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	configPath := filepath.Join(t.TempDir(), "models.json")
	config := fmt.Sprintf(`{
		"providers":{"test":{"base_url":%q,"api_format":"openai-compat","timeout":"2s"}},
		"models":{"chat":{"name":%q,"provider":"test","type":"dense","context_window":32768,"capabilities":["chat","stream","tool_call"]}},
		"defaults":{"agent":"chat"}
	}`, server.URL, Model)
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_LLM_CONFIG", configPath)
	return provider
}
