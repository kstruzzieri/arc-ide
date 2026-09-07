//go:build !darwin && !linux && !windows

package filesystem

import (
	"fmt"
	"os"
)

func openReadNoFollow(path string, _ bool) (*os.File, error) {
	return nil, fmt.Errorf("%w: %s", ErrNoFollowUnsupported, path)
}
