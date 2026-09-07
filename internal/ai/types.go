// Package ai provides the backend-authoritative identity layer for Firn's
// Golem chat: canonical repository binding with epochs, workspace resolution,
// and deterministic conversation IDs.
//
// Public identity types cross the Wails boundary as JSON and must never carry
// filesystem roots or paths; backend-only fields are excluded from marshaling.
package ai

import (
	"encoding/json"
	"errors"
)

// RepositoryIdentity names one incarnation of a bound repository. RepoKey is
// the full SHA-256 hex digest of the canonical repository root; RepoEpoch
// advances on every new incarnation and is never reused within a process.
type RepositoryIdentity struct {
	RepoKey   string `json:"repoKey"`
	RepoEpoch uint64 `json:"repoEpoch"`
}

// ConversationIdentity names one conversation within a bound repository.
type ConversationIdentity struct {
	RepoEpoch      uint64 `json:"repoEpoch"`
	WorkspaceID    string `json:"workspaceId"`
	ConversationID string `json:"conversationId"`
}

// RunIdentity names one run within a conversation.
type RunIdentity struct {
	RepoEpoch      uint64 `json:"repoEpoch"`
	WorkspaceID    string `json:"workspaceId"`
	ConversationID string `json:"conversationId"`
	RunID          string `json:"runId"`
}

// ResolvedWorkspace is the backend-only result of resolving a request identity
// against the current binding. RepoRoot and ToolRoot are filesystem paths and
// must never serialize.
type ResolvedWorkspace struct {
	RepositoryIdentity
	WorkspaceID         string
	WorkspaceName       string
	WorkspaceRel        string
	workspaceLexicalRel string // detected path before an in-repo symlink is resolved
	RepoRoot            string `json:"-"` // backend-only
	ToolRoot            string `json:"-"` // backend-only
}

// StatusRequest asks for the Golem status of one workspace under the caller's
// believed repository epoch.
type StatusRequest struct {
	RepoEpoch   uint64 `json:"repoEpoch"`
	WorkspaceID string `json:"workspaceId"`
}

// TurnRequest submits one turn for admission. ConsentChallengeID is set only
// on the exact retry of a previously issued consent challenge.
type TurnRequest struct {
	Identity           RunIdentity `json:"identity"`
	Message            string      `json:"message"`
	ContextRefs        []string    `json:"contextRefs"`
	ConsentChallengeID string      `json:"consentChallengeId,omitempty"`
}

// ContextReceipt summarizes what context was attached to an admitted turn.
type ContextReceipt struct {
	Included int `json:"included"`
	Bytes    int `json:"bytes"`
	Excluded int `json:"excluded"`
}

// ConsentChallenge is one pending Remote-egress consent decision, bound to the
// full run identity and the exact destination it would authorize.
type ConsentChallenge struct {
	ID                string              `json:"id"`
	Identity          RunIdentity         `json:"identity"`
	Destination       ProviderDestination `json:"destination"`
	DestinationDigest string              `json:"destinationDigest"`
	ExpiresAt         int64               `json:"expiresAt"` // Unix milliseconds
}

// TurnAdmission is the synchronous result of StartTurn.
type TurnAdmission struct {
	State            string              `json:"state"` // accepted | needs_consent
	Identity         RunIdentity         `json:"identity"`
	Destination      ProviderDestination `json:"destination"`
	Context          ContextReceipt      `json:"context"`
	ConsentChallenge *ConsentChallenge   `json:"consentChallenge,omitempty"`
}

// ActiveRunStatus describes one live run, including background runs whose
// repository incarnation is no longer current.
type ActiveRunStatus struct {
	Identity       RunIdentity `json:"identity"`
	WorkspaceLabel string      `json:"workspaceLabel"`
	State          string      `json:"state"` // running | canceling
}

// Status is the Wails-facing Golem status snapshot. It never carries
// filesystem roots or paths; InitError and Warnings are fixed messages only.
type Status struct {
	Available        bool                 `json:"available"`
	WorkspaceLabel   string               `json:"workspaceLabel"`
	Identity         ConversationIdentity `json:"identity"`
	Destination      *ProviderDestination `json:"destination,omitempty"`
	NeedsConsent     bool                 `json:"needsConsent"`
	ConsentChallenge *ConsentChallenge    `json:"consentChallenge,omitempty"`
	ActiveRuns       []ActiveRunStatus    `json:"activeRuns"`
	Warnings         []string             `json:"warnings,omitempty"`
	InitError        string               `json:"initError,omitempty"`
}

// RelayedEvent is one golem.Event relayed to the frontend unchanged, plus the
// original event's full JSON encoding in Raw.
type RelayedEvent struct {
	Protocol int             `json:"protocol"`
	ThreadID string          `json:"threadId"`
	RunID    string          `json:"runId"`
	Seq      uint64          `json:"seq"`
	Type     string          `json:"type"`
	Payload  json.RawMessage `json:"payload"`
	Raw      string          `json:"raw"`
}

// RunStatusEvent is the host-produced fallback status for a run that ended
// without a Golem terminal event, and the canceled notice for a declined
// consent challenge.
type RunStatusEvent struct {
	Identity RunIdentity `json:"identity"`
	State    string      `json:"state"` // failed | canceled fallback when Run emits no terminal
	Message  string      `json:"message,omitempty"`
}

// PublicError is the only error shape that crosses the Wails boundary. Code is
// a fixed internal classification; Error returns Message only, so no raw cause
// text can leak.
type PublicError struct {
	Code    string // fixed internal classification; Error() returns Message only
	Message string
}

func (e PublicError) Error() string { return e.Message }

// ErrRunFailed categorizes runner construction, launch, and terminal-less
// runner failures. The raw cause stays in the chain for host logging.
var ErrRunFailed = errors.New("golem run failed")

// ErrAssistantOutputLimit categorizes a run stopped because its assistant text
// crossed maxAssistantOutputBytes. It reaches SanitizeError nested inside
// ErrRunFailed — the terminal-less fallback wraps every cause that way — so its
// allowlist case is ordered ahead of the ErrRunFailed catch.
var ErrAssistantOutputLimit = errors.New("golem assistant output limit exceeded")

// SanitizeError projects any error onto the fixed public allowlist using only
// errors.Is against package sentinels. There is no pass-through fallback: an
// unrecognized error collapses to the generic catch-all. Raw error text —
// including the text of ErrWorkspaceUnavailable and ErrRequestRejected chains,
// which can embed absolute repository paths — is never returned.
func SanitizeError(err error) PublicError {
	switch {
	case errors.Is(err, ErrAgentConfigMissing):
		return PublicError{Code: "config_missing", Message: "Golem configuration was not found."}
	case errors.Is(err, ErrAgentConfigInvalid):
		return PublicError{Code: "config_invalid", Message: "Golem configuration is invalid."}
	case errors.Is(err, ErrConsentUnavailable):
		return PublicError{Code: "consent_unavailable", Message: "Remote consent storage is unavailable; open Golem configuration for repair steps."}
	case errors.Is(err, ErrRequestRejected):
		return PublicError{Code: "request_rejected", Message: "The Golem request is invalid or stale."}
	case errors.Is(err, ErrWorkspaceUnavailable):
		return PublicError{Code: "workspace_unavailable", Message: "The Golem workspace is unavailable."}
	case errors.Is(err, ErrAssistantOutputLimit):
		return PublicError{Code: "output_limit", Message: "The Golem reply exceeded the output limit."}
	case errors.Is(err, ErrRunFailed):
		return PublicError{Code: "run_failed", Message: "The Golem run failed."}
	default:
		return PublicError{Code: "golem_unavailable", Message: "Golem is unavailable."}
	}
}
