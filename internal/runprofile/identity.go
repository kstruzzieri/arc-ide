package runprofile

import "fmt"

// RunIdentity is embedded in every run event so that profile identity (the
// saved configuration) is distinct from execution identity (a specific launch).
// All fields are value types, so RunIdentity is safe to copy through the
// deep-copy compound snapshot path.
//
// A RunIdentity describes a compound step iff ParentRunInstanceID != "".
// StepIdx is 0 for the first step and is meaningful only for steps; it must not
// be omitempty or step 0 would be indistinguishable from an absent field.
type RunIdentity struct {
	RunInstanceID       string `json:"runInstanceId"`
	ProfileID           string `json:"profileId"`
	ParentRunInstanceID string `json:"parentRunInstanceId,omitempty"`
	StepIdx             int    `json:"stepIdx"`
	WorkspaceEpoch      uint64 `json:"workspaceEpoch"`
	LaunchSeq           uint64 `json:"launchSeq"`
}

// nextRunInstanceIDLocked returns a per-executor unique run instance id.
// Uniqueness is for the lifetime of this Executor, which is exactly what
// process/compound bookkeeping needs. The caller MUST hold e.mu.
func (e *Executor) nextRunInstanceIDLocked() string {
	e.nextRunSeq++
	return fmt.Sprintf("r%d", e.nextRunSeq)
}
