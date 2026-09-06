package ai

import (
	"sort"
	"strings"

	"github.com/kstruzzieri/go-llm/config"
)

// Mirrors, through the PUBLIC config API only, the admission planning
// go-llm's internal providerbootstrap performs for the one library route any
// Firn consumer enables: the agent route. The chat runtime supplies its own
// orchestrator and the commit generator sets DisableCompression, so no
// summarize route exists; planning is routed only by cmd/golem. Both
// exclusions are pinned by behavior (F7) and the admission-parity corpus
// (F15): if either reddens after a pin bump, re-decide spec D7.

// ReachableHop names how the agent route reaches a destination. Recommend
// marks upstream's recommendation route — Defaults["agent"] absent, every
// configured provider reachable (upstream I8).
type ReachableHop struct {
	UseCase   string
	Source    string
	Recommend bool
}

// ReachableDestination is one destination in the reachable set with every
// provenance hop that reaches it.
type ReachableDestination struct {
	Destination ProviderDestination
	Hops        []ReachableHop
}

// renderHop is the provenance string for one hop. The literals are fixed
// vocabulary; only Source is interpolated (boundary callers sanitize it).
func renderHop(h ReachableHop) string {
	if h.Recommend {
		return h.UseCase + " (recommendation)"
	}
	if h.Source == "" || h.Source == h.UseCase {
		return h.UseCase
	}
	return h.UseCase + " via defaults." + h.Source
}

// reachableDestinations derives the digest-sorted deduplicated destination
// set of the agent route exactly as upstream plans it: a present
// Defaults["agent"] (LITERAL key check, matching PlanAgentRoute) yields the
// strict transitive fallback chain; an absent one yields the recommendation
// set — every configured provider. A present-but-unresolvable chain is
// fatal upstream before any I/O, so it derives to empty; an unresolvable
// single hop (unknown provider, uncanonicalizable endpoint) contributes
// nothing here — upstream's planner would refuse to admit the whole route on
// that same failure, while Firn only drops the hop from this read-only
// listing.
func reachableDestinations(cfg *config.Config) []ReachableDestination {
	if cfg == nil {
		return nil
	}
	byDigest := map[string]*ReachableDestination{}
	add := func(providerName, modelName string, hop ReachableHop) {
		prov := cfg.Provider(providerName)
		if prov == nil {
			return
		}
		endpoint, local, err := NormalizeEndpoint(prov.BaseURL)
		if err != nil {
			return
		}
		classification := "remote"
		if local {
			classification = "local"
		}
		digest := destinationDigest(providerName, endpoint)
		entry, ok := byDigest[digest]
		if !ok {
			entry = &ReachableDestination{Destination: ProviderDestination{
				Provider: providerName, Model: modelName, Endpoint: endpoint,
				Classification: classification, Digest: digest,
			}}
			byDigest[digest] = entry
		}
		for _, h := range entry.Hops {
			if h == hop {
				return
			}
		}
		entry.Hops = append(entry.Hops, hop)
	}

	if _, ok := cfg.Defaults[useCaseAgent]; !ok {
		names := make([]string, 0, len(cfg.Providers))
		for name := range cfg.Providers {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			add(name, "", ReachableHop{UseCase: useCaseAgent, Recommend: true})
		}
	} else {
		chain, err := cfg.RoleFallbackChain(useCaseAgent)
		if err != nil {
			return nil
		}
		for _, selector := range chain {
			providerName, modelName, found := strings.Cut(selector, "/")
			if !found {
				continue
			}
			add(providerName, modelName, ReachableHop{UseCase: useCaseAgent, Source: useCaseAgent})
		}
	}

	digests := make([]string, 0, len(byDigest))
	for d := range byDigest {
		digests = append(digests, d)
	}
	sort.Strings(digests)
	out := make([]ReachableDestination, 0, len(digests))
	for _, d := range digests {
		out = append(out, *byDigest[d])
	}
	return out
}
