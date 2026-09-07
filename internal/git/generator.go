package git

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"unicode"

	"github.com/kstruzzieri/go-llm/agent"
	"github.com/kstruzzieri/go-llm/golem"
	"github.com/kstruzzieri/go-llm/provider"
)

// maxPromptBytes bounds the serialized staged-diff context handed to golem.
const maxPromptBytes = 48 * 1024

const truncatedDiffMarker = "\n[diff truncated for prompt budget]"

const generateSystem = "Generate commit messages using only the supplied staged-diff context. Do not call tools."

const generateInstruction = `Write a git commit message for the staged diff below.
Rules: imperative mood, subject line of at most 72 characters, optional short
body separated by a blank line explaining why. Output ONLY the commit message,
no fences, no commentary.`

// MessageGenerator produces commit messages from a staged diff via the public
// golem runtime, behind the consent-derived destination policy.
type MessageGenerator struct {
	destinationPolicy func() provider.DestinationPolicy
}

func NewMessageGenerator() *MessageGenerator { return &MessageGenerator{} }

// SetDestinationPolicySource injects the consent-derived policy, evaluated
// fresh on every Generate so a new grant applies without restart. Nil (the
// default) leaves the zero policy: local-only, fail closed. Firn only ever
// builds an exact-grant policy here — the go-llm variant that grants every
// destination is forbidden in Firn (spec D2).
func (g *MessageGenerator) SetDestinationPolicySource(src func() provider.DestinationPolicy) {
	g.destinationPolicy = src
}

// deniedFieldCap bounds each rendered field in RUNES.
const deniedFieldCap = 256

// scrubField drops control, format, and line/paragraph separator runes and
// truncates on a rune boundary, so a field can neither forge message lines
// nor split a multibyte sequence (spec D3b).
func scrubField(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Zl, r) || unicode.Is(unicode.Zp, r) {
			continue
		}
		out = append(out, r)
		if len(out) == deniedFieldCap {
			break
		}
	}
	return string(out)
}

// destinationDeniedMessage renders a boundary-safe description from the
// TYPED error's own fields only — never from the surrounding chain (F14).
func destinationDeniedMessage(err error) (string, bool) {
	var denied *provider.DestinationDeniedError
	if !errors.As(err, &denied) {
		return "", false
	}
	target := denied.Destination.String()
	if denied.Destination.IsZero() {
		target = "provider " + denied.Provider
	}
	purpose := denied.Purpose
	if purpose == "" {
		purpose = "unknown purpose"
	}
	return "destination " + scrubField(target) + " is not consented for " + scrubField(purpose), true
}

// Available reports whether commit-message generation is embedded in Firn.
// Always true: a static probe cannot predict whether generation will work — a
// missing models.json falls back to a synthetic local-provider config, and a
// present config can still point at a stopped provider — so failures surface
// as errors from Generate instead of hiding the feature.
func (*MessageGenerator) Available(context.Context) bool { return true }

// Generate asks the embedded golem runtime for a commit message describing diff.
func (g *MessageGenerator) Generate(ctx context.Context, root, diff string) (message string, err error) {
	if strings.TrimSpace(diff) == "" {
		return "", errors.New("nothing staged: stage changes before generating a message")
	}
	stagedDiff, err := stagedDiffContext(diff)
	if err != nil {
		return "", fmt.Errorf("golem runtime context: %w", err)
	}

	policy := provider.DestinationPolicy{}
	if g.destinationPolicy != nil {
		policy = g.destinationPolicy()
	}
	runtime, err := golem.New(ctx, golem.Options{
		Root:     root,
		System:   generateSystem,
		MaxSteps: 1, // Never send built-in read-tool output in a second provider request.
		// No ThreadID is ever submitted, so history compression cannot run for
		// this consumer; disabling it keeps the summarize route OUT of
		// destination admission entirely (spec D3a).
		DisableCompression: true,
		// InputCeiling is tokens, not bytes: the 48 KiB byte-bounded context is
		// ~12K tokens, well under it. It does not track the configured model's
		// real context window; an undersized model rejects at the provider and
		// that error surfaces from Run.
		Budget:            agent.Budget{InputCeiling: 32 * 1024},
		DestinationPolicy: policy,
		OnWarning:         func(warning error) { log.Printf("git: golem warning: %v", warning) },
	})
	if err != nil {
		if msg, ok := destinationDeniedMessage(err); ok {
			// Wraps the SENTINEL only: classification survives, the original
			// chain does not travel (spec D3b).
			return "", fmt.Errorf("commit message generation blocked: %s; use Approve missing destinations in the Golem configuration view: %w", msg, provider.ErrDestinationDenied)
		}
		return "", fmt.Errorf("golem runtime initialization: %w", err)
	}
	defer func() {
		if closeErr := runtime.Close(); closeErr != nil {
			message = ""
			err = errors.Join(err, fmt.Errorf("golem runtime close: %w", closeErr))
		}
	}()

	result, err := runtime.Run(ctx, golem.Turn{
		RunID:   "firn-commit-message",
		Message: generateInstruction,
		Context: []golem.ContextItem{stagedDiff},
	}, func(golem.Event) error { return nil })
	if err != nil {
		if msg, ok := destinationDeniedMessage(err); ok {
			return "", fmt.Errorf("commit message generation blocked: %s; use Approve missing destinations in the Golem configuration view: %w", msg, provider.ErrDestinationDenied)
		}
		return "", fmt.Errorf("golem runtime run: %w", err)
	}

	message = strings.TrimSpace(result.Answer)
	if message == "" || strings.ContainsRune(message, '\x00') {
		return "", errors.New("golem returned an unusable message")
	}
	return message, nil
}

func stagedDiffContext(diff string) (golem.ContextItem, error) {
	searchLimit := min(len(diff), maxPromptBytes)
	item := golem.ContextItem{Description: "staged diff", Value: diff[:searchLimit]}
	encoded, err := json.Marshal([]golem.ContextItem{item})
	if err != nil {
		return golem.ContextItem{}, fmt.Errorf("serialize staged diff: %w", err)
	}
	if searchLimit == len(diff) && len(encoded) <= maxPromptBytes {
		return item, nil
	}

	low, high := 0, searchLimit
	for low < high {
		mid := low + (high-low+1)/2
		item.Value = diff[:mid] + truncatedDiffMarker
		encoded, err = json.Marshal([]golem.ContextItem{item})
		if err != nil {
			return golem.ContextItem{}, fmt.Errorf("serialize staged diff: %w", err)
		}
		if len(encoded) <= maxPromptBytes {
			low = mid
		} else {
			high = mid - 1
		}
	}
	item.Value = diff[:low] + truncatedDiffMarker
	encoded, err = json.Marshal([]golem.ContextItem{item})
	if err != nil {
		return golem.ContextItem{}, fmt.Errorf("serialize staged diff: %w", err)
	}
	if len(encoded) > maxPromptBytes {
		return golem.ContextItem{}, errors.New("serialized staged diff exceeds prompt budget")
	}
	return item, nil
}
