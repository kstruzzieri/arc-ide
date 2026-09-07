/**
 * The single copy vocabulary for Golem settings diagnostics, shared by the dock
 * readout and the configuration workspace (#263 spec §5.6, §4.6).
 *
 * A diagnostic is identified by the (subjectKind, subjectName) TUPLE, never by
 * the name alone: `agent` is simultaneously a plausible provider name, a role
 * name, and a use case, so an unprefixed subject is genuinely ambiguous to the
 * reader and to any later code that routes an error onto a row.
 */

import type { DiagnosticSubjectKind, SettingsDiagnosticCode } from '../types/golem';
import type { ProfileDiagnostic } from '../types/golemConfig';

/** Total map over the closed code set; the validator guarantees membership, so
 * no fallback branch exists to rot. Copy is verbatim from spec §5.6 — the
 * write/action codes below reach this map through apply results, not loads. */
const DIAGNOSTIC_TEXT: Record<SettingsDiagnosticCode, string> = {
  config_missing: 'No models.json was found at any discovery location.',
  json_invalid: 'The configuration file is not valid JSON.',
  config_invalid: 'The configuration was rejected while loading.',
  agent_role_missing: 'No usable agent role is configured.',
  agent_capabilities_insufficient: 'The agent model must support chat, stream, and tool_call.',
  provider_endpoint_unsupported: 'This provider endpoint is not a usable URL.',
  projection_limited: 'Configuration is too large to display in full.',
  duplicate_keys: 'Duplicate JSON keys make this configuration read-only.',
  provider_required: 'At least one provider is required.',
  provider_name_invalid: 'A provider name is invalid.',
  provider_endpoint_invalid: 'A provider endpoint is invalid.',
  provider_format_invalid: 'A provider API format is invalid.',
  slot_policy_invalid: 'A provider slot policy is invalid.',
  model_invalid: 'A model entry is invalid.',
  think_invalid: 'A thinking configuration is invalid.',
  provider_not_found: 'A model references a provider that does not exist.',
  defaults_invalid: 'A default route is invalid.',
  key_reference_malformed: 'An API-key environment reference is malformed.',
  key_reference_unavailable: 'An API-key environment variable is unavailable.',
  selector_conflict: 'Models sharing a provider/model selector disagree.',
  identifier_not_editable:
    'An identifier is empty or contains unsafe control characters; edit the file externally.',
  invalid_argument: 'A staged change is invalid.',
  role_not_found: 'That model route no longer exists.',
  provider_exists: 'A provider with that name already exists.',
  provider_in_use: 'This provider is still used by a model.',
  eligibility_ineligible: 'This model does not meet every affected use-case requirement.',
  eligibility_unknown: 'Model eligibility is still unverified.',
  key_value_invalid: 'API keys must be non-empty literal values.',
  profile_source_unavailable: 'The selected profile could not be loaded.',
  consent_store_failed: 'Destination approval may have been saved; configuration was not applied.',
  config_save_failed: 'Configuration could not be saved.',
};

const SUBJECT_KIND_LABEL: Record<Exclude<DiagnosticSubjectKind, ''>, string> = {
  role: 'role',
  model: 'model',
  provider: 'provider',
  use_case: 'use case',
};

export interface FormattedSettingsDiagnostic {
  /** The bounded, code-derived sentence. */
  text: string;
  /** `''` when the diagnostic names no subject, else `<kind> <name>`. */
  subject: string;
}

/**
 * Renders one diagnostic as its fixed sentence plus a kind-prefixed subject.
 * An unkinded subject keeps its bare name — the backend only omits the kind
 * when the diagnostic is about the document as a whole.
 */
export function formatSettingsDiagnostic(
  code: SettingsDiagnosticCode,
  subjectKind: DiagnosticSubjectKind,
  subjectName: string
): FormattedSettingsDiagnostic {
  return {
    text: DIAGNOSTIC_TEXT[code],
    subject:
      subjectName === ''
        ? ''
        : subjectKind === ''
          ? subjectName
          : `${SUBJECT_KIND_LABEL[subjectKind]} ${subjectName}`,
  };
}

/**
 * The profile-store vocabulary reuses the ONE copy map above, on exactly the
 * §5.6 mapping the apply path already uses for a profile-origin write: an
 * invalid id is an invalid argument, unreadable content is invalid content, and
 * every other store failure is "the selected profile could not be loaded".
 * Nothing here invents a second sentence for the same condition.
 */
const PROFILE_DIAGNOSTIC_CODE: Record<ProfileDiagnostic['code'], SettingsDiagnosticCode> = {
  invalid_id: 'invalid_argument',
  not_found: 'profile_source_unavailable',
  curated_read_only: 'profile_source_unavailable',
  store_unsafe: 'profile_source_unavailable',
  io: 'profile_source_unavailable',
  profile_limit: 'profile_source_unavailable',
  config_invalid: 'config_invalid',
  active_config_invalid: 'config_invalid',
};

/** One bounded sentence for the first profile diagnostic a load reported. */
export const formatProfileDiagnostic = (diagnostic: ProfileDiagnostic): string =>
  DIAGNOSTIC_TEXT[PROFILE_DIAGNOSTIC_CODE[diagnostic.code]];
