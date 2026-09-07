package ai

import (
	"testing"

	"github.com/kstruzzieri/go-llm/config"
)

func reachableFixtureConfig() *config.Config {
	return &config.Config{
		Providers: map[string]config.ProviderConfig{
			"hosted": {BaseURL: "https://api.example.com/v1", APIFormat: "openai-compat"},
			"backup": {BaseURL: "https://alt.example.net", APIFormat: "openai-compat"},
			"local":  {BaseURL: "http://127.0.0.1:11434", APIFormat: "ollama"},
		},
		Models: map[string]config.ModelConfig{
			"agent-m":   {Name: "front", Provider: "hosted", Type: "dense", Capabilities: []string{"chat", "stream", "tool_call"}, Fallbacks: []string{"agent-fb"}},
			"agent-fb":  {Name: "spare", Provider: "backup", Type: "dense", Capabilities: []string{"chat", "stream", "tool_call"}},
			"unrelated": {Name: "digest", Provider: "local", Type: "dense", Capabilities: []string{"chat", "stream"}},
		},
		Defaults: map[string]string{"agent": "agent-m"},
	}
}

// F8 strict half: agent chain INCLUDING fallbacks, provenance attached;
// providers on no route are absent.
func TestReachableDestinationsCoverAgentChain(t *testing.T) {
	got := reachableDestinations(reachableFixtureConfig())
	if len(got) != 2 {
		t.Fatalf("want hosted+backup, got %d: %+v", len(got), got)
	}
	byProvider := map[string]ReachableDestination{}
	for _, d := range got {
		byProvider[d.Destination.Provider] = d
	}
	if d := byProvider["backup"]; len(d.Hops) != 1 || d.Hops[0] != (ReachableHop{UseCase: "agent", Source: "agent"}) {
		t.Fatalf("fallback hop: %+v", d.Hops)
	}
	if _, ok := byProvider["local"]; ok {
		t.Fatal("provider on no route must be absent")
	}
	for i := 1; i < len(got); i++ {
		if got[i-1].Destination.Digest >= got[i].Destination.Digest {
			t.Fatal("result must be digest-sorted")
		}
	}
}

// F8 recommendation half: absent Defaults["agent"] reaches EVERY provider.
func TestReachableDestinationsRecommendWhenAgentUnbound(t *testing.T) {
	cfg := reachableFixtureConfig()
	delete(cfg.Defaults, "agent")
	got := reachableDestinations(cfg)
	if len(got) != 3 {
		t.Fatalf("recommendation must reach every configured provider, got %d", len(got))
	}
	for _, d := range got {
		if len(d.Hops) != 1 || !d.Hops[0].Recommend || d.Hops[0].UseCase != "agent" || d.Destination.Model != "" {
			t.Fatalf("recommendation entry: %+v", d)
		}
	}
}

func TestReachableDestinationsEmptyOnUnresolvableChainOrNil(t *testing.T) {
	cfg := reachableFixtureConfig()
	cfg.Defaults["agent"] = "no-such-role"
	if got := reachableDestinations(cfg); len(got) != 0 {
		t.Fatalf("unresolvable chain: %+v", got)
	}
	if got := reachableDestinations(nil); len(got) != 0 {
		t.Fatalf("nil config: %+v", got)
	}
}

func TestRenderHop(t *testing.T) {
	if got := renderHop(ReachableHop{UseCase: "agent", Source: "agent"}); got != "agent" {
		t.Fatalf("direct: %q", got)
	}
	if got := renderHop(ReachableHop{UseCase: "agent", Recommend: true}); got != "agent (recommendation)" {
		t.Fatalf("recommend: %q", got)
	}
}
