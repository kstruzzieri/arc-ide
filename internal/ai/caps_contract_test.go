package ai

import (
	"testing"

	"github.com/kstruzzieri/go-llm/agent"
	"github.com/kstruzzieri/go-llm/config"
	"github.com/kstruzzieri/go-llm/provider"
)

// Cross-repo drift test (#476 consumer side). Expected sets are spelled
// literally here and ONLY here. Pins the VALUE contract; the derivation
// itself is enforced by review (spec D4).
func TestModelCallCapabilitiesContract(t *testing.T) {
	if got, want := agent.ModelCallCapabilities(true), provider.CapChat|provider.CapStream|provider.CapToolCall; got != want {
		t.Fatalf("tool-bearing call shape drifted: got %v want %v", got, want)
	}
	if got, want := agent.ModelCallCapabilities(false), provider.CapChat|provider.CapStream; got != want {
		t.Fatalf("tool-less call shape drifted: got %v want %v", got, want)
	}
}

func TestFloorsMatchSharedCalculation(t *testing.T) {
	if requiredAgentCaps != agent.ModelCallCapabilities(true) {
		t.Fatal("requiredAgentCaps must equal agent.ModelCallCapabilities(true)")
	}
	if firnUseCaseFloors["chat"] != agent.ModelCallCapabilities(false) {
		t.Fatal("the chat floor must equal agent.ModelCallCapabilities(false)")
	}
	if firnUseCaseFloors[config.UseCasePlanning] != agent.ModelCallCapabilities(true) {
		t.Fatal("the planning floor must be the tool-bearing shared calculation")
	}
}
