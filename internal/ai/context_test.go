package ai

import (
	"context"
	"errors"
	"testing"
)

func TestResolveContextRefsPhaseOne(t *testing.T) {
	got, err := ResolveContextRefs(context.Background(), nil)
	if err != nil || got != nil {
		t.Fatalf("empty refs = %#v, %v", got, err)
	}
	_, err = ResolveContextRefs(context.Background(), []string{"opaque-but-unissued"})
	if !errors.Is(err, ErrUnknownContextRef) {
		t.Fatalf("error = %v, want ErrUnknownContextRef", err)
	}
}

func TestResolveContextRefsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := ResolveContextRefs(ctx, []string{"opaque-but-unissued"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if errors.Is(err, ErrUnknownContextRef) {
		t.Fatalf("canceled context reached reference handling: %v", err)
	}
}
