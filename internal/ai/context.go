package ai

import (
	"context"
	"errors"
	"fmt"

	"github.com/kstruzzieri/go-llm/golem"
)

// ErrUnknownContextRef marks a context reference that was never issued.
var ErrUnknownContextRef = errors.New("unknown context reference")

// ResolveContextRefs maps opaque frontend context references to trusted
// context items. It is the only function allowed to construct
// []golem.ContextItem from Wails input, and it never reads a file. Phase 1
// issues no references, so any non-empty ref set is unknown.
func ResolveContextRefs(ctx context.Context, refs []string) ([]golem.ContextItem, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(refs) == 0 {
		return nil, nil
	}
	return nil, fmt.Errorf("%w: %d reference(s)", ErrUnknownContextRef, len(refs))
}
