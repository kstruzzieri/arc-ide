/**
 * Golem configuration workspace — the app-global `tab-golem-config` surface
 * (#263 Slice B, spec §3.1/§4).
 *
 * This component owns the whole write flow: the draft, the key vault, the two
 * bootstrap sources, the Apply/Confirm/Cancel calls, and every §4.6/§4.6a
 * transition they can land in. Two rules shape all of it:
 *
 * - The draft and any pending API-key VALUE live in refs on THIS component,
 *   never in a store and never in anything serializable (§3.2). Crossing the
 *   pane boundary for tab close and app quit therefore ships FUNCTIONS through
 *   `configCloseGuard`, not data.
 * - `settleDraft` is the single place a draft settles and the single place key
 *   refs are cleared (§5.6). Every outcome below — result, expiry, cancel,
 *   discard, teardown, transport rejection — reaches it through `settle`, so
 *   "were the values dropped?" has exactly one answer per outcome.
 *
 * It also hosts a SECOND, independent flow: the grant-only approval (spec D13,
 * I15). It shares the consent prompt and the cancel binding but nothing else —
 * it writes no document, so it never reaches `settle` and therefore never
 * settles a draft or clears a key ref. The prompt's `intent` is what keeps the
 * two apart; the section that owns it is marked below.
 *
 * There is one instance per app, so nothing here is workspace-scoped: Firn's
 * settings calls read one process-wide snapshot.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApplyGolemSettings,
  CancelGolemSettingsApply,
  ConfirmGolemDestinationGrants,
  ConfirmGolemSettingsApply,
  CreateGolemSettings,
  ListGolemProfiles,
  LoadGolemProfile,
  PrepareGolemDestinationGrants,
  ReloadGolemSettings,
} from '../../wails/bindings';
import type { ai } from '../../wails/bindings';
import {
  boundedGolemMessage,
  parseSettingsReloadResult,
  type ProviderProjection,
  type SettingsDiagnostic,
  type SettingsProjection,
} from '../../types/golem';
import {
  KeyVault,
  buildApplyRequest,
  changeStableID,
  cleanDraft,
  draftChangeCount,
  isDraftDirty,
  meetsUseCaseFloor,
  parseCancelSettingsApplyResult,
  parseDestinationGrantsResult,
  parseGolemProfileListResult,
  parseGolemProfileLoadResult,
  parseSettingsApplyResult,
  projectDraft,
  readActiveProfile,
  recordApplyProvenance,
  retainsKeys,
  setTargetRevision,
  settleDraft,
  stageChange,
  unstageChange,
  type ApplyChallenge,
  type ApplyConflictKind,
  type ApplyMode,
  type Change,
  type ChangeDropSet,
  type ConsentPromptIntent,
  type DestinationGrantsStatus,
  type DraftEvent,
  type ProfileDraftProjection,
  type SettingsApplyRequest,
  type SettingsApplyResult,
} from '../../types/golemConfig';
import { formatProfileDiagnostic, formatSettingsDiagnostic } from '../../utils/settingsDiagnostics';
import { ApplyBar, type EditorFocusRequest } from './ApplyBar';
import { registerConfigCloseHandler, type ConfigCloseIntent } from './configCloseGuard';
import styles from './GolemConfig.module.css';
import {
  APPLIED_SOURCE_VALUE,
  BLANK_SOURCE_VALUE,
  TRANSPORT_UNAVAILABLE_COPY,
  buildProfileSelectModel,
  type ProfileListState,
} from './profileSelect';
import { ProvidersCard } from './ProvidersCard';
import { RoutingCard, routingOwnsDiagnostic } from './RoutingCard';
import { StatusText, type StatusTone } from './StatusText';

const STATE_LABEL: Record<SettingsProjection['state'], string> = {
  ready: 'Ready',
  limited: 'Limited',
  invalid: 'Invalid',
  missing: 'Missing',
};

const STATE_TONE: Record<SettingsProjection['state'], StatusTone> = {
  ready: 'ok',
  limited: 'warn',
  invalid: 'bad',
  missing: 'dim',
};

const ORIGIN_LABEL: Record<SettingsProjection['sourceOrigin'], string> = {
  none: 'No configuration found',
  env: 'Environment override',
  working_directory: 'Working directory models.json',
  user_config: 'User configuration directory',
  legacy: 'Legacy configuration directory',
};

/**
 * Why editing is off (spec §4.6). `limited` covers both write-blocked reasons —
 * a read-only document and an unsafe mutation identity — because the backend
 * collapses `readOnly || !editable` onto that state and emits the naming
 * diagnostic beside it. `missing` is not a block: it is the bootstrap path.
 */
const EDITING_UNAVAILABLE: Partial<Record<SettingsProjection['state'], string>> = {
  limited:
    'Editing is unavailable while this configuration is Limited. The notices below name the reason; repair it in the file, then Refresh.',
  invalid:
    'Editing is unavailable: this configuration could not be loaded, so there is nothing safe to change. Repair it in the file, then Refresh.',
};

/** The CAS token is 64 hex characters; the head identifies a revision at a
 * glance and the full value stays available on hover. */
const REVISION_HEAD = 12;

/** Slice B invokes the profile loader for this one fixed bootstrap CTA (§5.3). */
const CURATED_PROFILE = 'curated/local';

/** The one copy vocabulary, shared with the diagnostics the backend returns. */
const copy = (code: Parameters<typeof formatSettingsDiagnostic>[0]): string =>
  formatSettingsDiagnostic(code, '', '').text;

const APPLIED = 'Configuration applied.';
const APPLIED_UNCERTAIN =
  'Configuration applied. Golem could not confirm the write reached disk; check it after a restart.';
/** §5.6: shown before the base copy for `consentOutcome: 'recorded'`. */
const CONSENT_RECORDED = 'Destination approval saved; configuration not applied.';
const CONSENT_UNCERTAIN = copy('consent_store_failed');
const CHALLENGE_EXPIRED =
  'The approval request expired. Nothing was written. Re-enter any API key and apply again.';
const CHALLENGE_CANCELLED =
  'The approval request was cancelled. Nothing was written. Re-enter any API key and apply again.';
const CANCEL_FAILED =
  'The approval request could not be cancelled. Try again before closing this tab.';
const BUSY_NOTICE =
  'Golem is busy — a run or pending consent prompt owns the idle barrier. Nothing was written; retry when idle.';
const LIMITED_NOTICE = 'This configuration cannot be written. Nothing was applied.';
/** §5.2 fixed copy for the outcome-unknown recovery state. */
const OUTCOME_UNKNOWN = 'The Apply result is unknown. Refresh before making more changes.';
const BUILD_REFUSED = `${copy('invalid_argument')} Review the changes waiting for Apply, then try again.`;

const UNSTAGED_GATE =
  'Apply is unavailable while an editor has unstaged changes. Stage or cancel them first.';
const REVIEW_GATE =
  'Apply is unavailable until every change marked Needs review is re-staged or discarded.';
/** A `target` or `profile_source` conflict: a document moved under the draft. */
const DOCUMENT_CONFLICT =
  'The configuration moved while this draft was open, so nothing was written. Reload and re-stage each retained change against the fresh document, or discard the draft.';
/**
 * A `challenge` conflict is a different animal: nothing moved, the approval
 * simply no longer matches the request it was granted for. The token is spent
 * either way (§4.6a), so there is nothing to reload — only a draft to re-stage.
 */
const CHALLENGE_CONFLICT =
  'The destination approval no longer matches this request, so nothing was written and the approval was cancelled. Re-stage each retained change, then apply again to approve the destination once more.';
const BOOTSTRAP_GATE =
  'A blank configuration needs one provider and an agent route that meets chat, stream, and tool_call.';

/**
 * The grant-only approval (spec D13, I15). It approves destinations for the
 * ACTIVE configuration and writes no document, so every outcome below speaks
 * only about approval — and none of them mentions the draft, because none of
 * them touches it.
 */
const APPROVE_ACTION = 'Approve missing destinations';
const GRANT_NONE =
  'Nothing to approve. Every remote destination the agent route reaches is already approved.';
/** Never "nothing to approve": a configuration that would not load answered
 * nothing at all, and the diagnostics on this page are the repair. */
const GRANT_CONFIG_INVALID = 'Configuration failed to load — fix the diagnostics above first.';
/** The store's own repair path: one invalid record fails the whole file
 * closed, and no grant can persist until it is fixed or removed. */
const GRANT_UNAVAILABLE =
  'Consent storage unavailable — see repair steps: fix or remove ~/.firn/golem-consent.json, restart Firn, then approve again. Nothing can be approved until it opens cleanly.';
const GRANT_GRANTED = 'Destinations approved. Your configuration was not changed.';
const GRANT_UNCERTAIN =
  'Golem could not confirm whether the approval was saved. Try approving again.';
const GRANT_CONFLICT = `The configuration changed while this approval was open, so nothing was approved. Choose ${APPROVE_ACTION} again to review the current set.`;
const GRANT_EXPIRED = `The approval request expired. Nothing was approved. Choose ${APPROVE_ACTION} again.`;
const GRANT_CANCELLED = 'The approval request was cancelled. Nothing was approved.';

/** One line per closed status; `consent_required` answers with the prompt. */
const GRANT_NOTICE: Record<DestinationGrantsStatus, string> = {
  none: GRANT_NONE,
  consent_required: '',
  granted: GRANT_GRANTED,
  uncertain: GRANT_UNCERTAIN,
  conflict: GRANT_CONFLICT,
  busy: BUSY_NOTICE,
  unavailable: GRANT_UNAVAILABLE,
  config_invalid: GRANT_CONFIG_INVALID,
};

/**
 * The prompt's opening sentence. The intent decides what is at stake — a
 * settings apply is holding a write, a grant-only approval is holding nothing
 * — and the count decides the grammar.
 */
const promptLead = (intent: ConsentPromptIntent, count: number): string => {
  const subject = count === 1 ? 'this remote destination' : `these ${count} remote destinations`;
  return intent === 'grant-only'
    ? `Approve ${subject}. Nothing is written to your configuration.`
    : `Approve ${subject} before the configuration is written.`;
};

const DISCARD_BODY =
  'The staged changes and any API key you entered are dropped. Nothing has been written, and the file on disk does not change.';
const DISCARD_BODY_CHALLENGED = `${DISCARD_BODY} The pending destination approval is cancelled first.`;
/**
 * A grant-only prompt with a CLEAN draft behind it: closing, refreshing, or
 * switching source has nothing staged to discard — the only thing `unsaved`
 * is protecting is the open approval, so the dialog says exactly that instead
 * of claiming staged changes and a key are being dropped.
 */
const CANCEL_GRANT_TITLE = 'Cancel the pending approval?';
const CANCEL_GRANT_BODY = 'The destination approval is cancelled. Nothing staged is dropped.';
const CANCEL_GRANT_CONFIRM = 'Cancel approval';

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; projection: SettingsProjection; busyNotice: boolean }
  | { kind: 'error'; message: string };

/**
 * Everything the cards render. The active projection satisfies it, and so does
 * a profile preview or the blank builder — which is exactly the point: a draft
 * layered on a replacement source paints THAT document, not the applied one
 * underneath it (§3.3).
 */
type Body = Pick<
  SettingsProjection,
  'state' | 'readOnly' | 'editable' | 'routes' | 'models' | 'providers' | 'diagnostics'
>;

/** A blank source is frontend builder state: no document exists yet (§3.3). */
const BLANK_PREVIEW: ProfileDraftProjection = {
  state: 'ready',
  readOnly: false,
  editable: true,
  routes: [],
  models: [],
  providers: [],
  diagnostics: [],
};

/** What the last write left behind. Exactly one shape, cleared as one value. */
interface WriteOutcome {
  challenge: ApplyChallenge | null;
  /**
   * Which flow the open challenge belongs to. It rides beside the challenge
   * rather than in a state of its own so the two can never disagree: one
   * `setOutcome` opens the prompt and names its intent, and clearing the
   * challenge clears the intent with it.
   */
  intent: ConsentPromptIntent;
  drops: ChangeDropSet[] | null;
  conflict: ApplyConflictKind | null;
  /** A busy result: the same request stays retryable. */
  busy: boolean;
  /** Outcome-unknown recovery: every write is disabled (§4.6a). */
  unknown: boolean;
  notice: string;
  diagnostics: SettingsDiagnostic[];
}

const NO_OUTCOME: WriteOutcome = {
  challenge: null,
  intent: 'settings-apply',
  drops: null,
  conflict: null,
  busy: false,
  unknown: false,
  notice: '',
  diagnostics: [],
};

interface Prompt {
  title: string;
  body: string;
  confirmLabel: string;
}

/**
 * §5.2: a blank Apply stays disabled until one provider plus a floor-valid
 * agent route can form a complete `BootstrapSpec`. The frontend checks it so
 * the refusal lands on the control rather than as an opaque diagnostics result;
 * the backend checks it again before `NewDocument`.
 */
function bootstrapComplete(changes: readonly Change[]): boolean {
  if (!changes.some((change) => change.kind === 'provider-add')) return false;
  const agent = changes.find((change) => change.kind === 'route' && change.useCase === 'agent');
  return agent?.kind === 'route' && meetsUseCaseFloor('agent', agent.exposedCaps);
}

/** §5.6: `recorded` and `uncertain` both prepend their own sentence. */
const consentCopy = (outcome: 'unchanged' | 'recorded' | 'uncertain'): string =>
  outcome === 'recorded' ? CONSENT_RECORDED : outcome === 'uncertain' ? CONSENT_UNCERTAIN : '';

export function GolemConfigWorkspace({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [inFlight, setInFlight] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(false);
  const generation = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // The draft and the pending key VALUES live here and nowhere else (§3.2):
  // the values in a plain ref, reachable only through the KeyVault facade, so
  // they never enter React state, a store, or anything serializable.
  const keyRefs = useRef(new Map<string, string>());
  const vault = useMemo(() => new KeyVault(keyRefs.current), []);
  const [draft, setDraft] = useState(cleanDraft);
  /** Editors holding fields the user has not staged (§4.2: Apply is blocked). */
  const [unstagedEditors, setUnstagedEditors] = useState<ReadonlySet<string>>(new Set());
  /** Bumped by every draft reset, to remount the cards and their editors. */
  const [draftEpoch, setDraftEpoch] = useState(0);
  /** The profile preview or blank builder a replacement source paints (§3.3). */
  const [preview, setPreview] = useState<ProfileDraftProjection | null>(null);
  const [sourceError, setSourceError] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [outcome, setOutcome] = useState<WriteOutcome>(NO_OUTCOME);
  /** The grant-only action's own line. It never speaks about the draft. */
  const [grantNotice, setGrantNotice] = useState('');
  /** True while an Apply/Confirm/Cancel owns the surface (§3.3). */
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [focusRequest, setFocusRequest] = useState<EditorFocusRequest | null>(null);

  /** The exact request Confirm and Retry resend: Call 1 retained none of it. */
  const pendingRequestRef = useRef<SettingsApplyRequest | null>(null);
  /** The settings RPC an app-close handshake must wait out (§4.6a). */
  const writeRef = useRef<Promise<void>>(Promise.resolve());
  const answerRef = useRef<((ok: boolean) => void) | null>(null);

  const invalidateLoads = useCallback(() => {
    generation.current += 1;
    setInFlight(false);
    setSourceLoading(false);
  }, []);

  const beginOperation = (): boolean => {
    if (sendingRef.current) return false;
    sendingRef.current = true;
    setSending(true);
    return true;
  };

  const endOperation = (): void => {
    sendingRef.current = false;
    setSending(false);
  };

  const load = useCallback(async (explicit: boolean): Promise<boolean> => {
    const gen = ++generation.current;
    setSourceLoading(false);
    setFocusRequest(null);
    setInFlight(true);
    try {
      const result = parseSettingsReloadResult(await ReloadGolemSettings());
      if (gen !== generation.current) return false; // superseded or unmounted
      setPhase({
        kind: 'ready',
        projection: result.projection,
        // A busy reload on open silently shows the effective snapshot; only the
        // explicit Refresh action surfaces the notice.
        busyNotice: explicit && result.busy,
      });
      // The draft targets whichever revision the document is on now — including
      // after a conflict, where adopting it is the whole point of the reload.
      setDraft((current) => setTargetRevision(current, result.projection.revision));
      return !result.busy;
    } catch (err) {
      if (gen !== generation.current) return false;
      setPhase({ kind: 'error', message: boundedGolemMessage(err) });
      return false;
    } finally {
      if (gen === generation.current) setInFlight(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    return () => {
      generation.current += 1; // invalidate any pending response on unmount
    };
  }, [load]);

  const [profileList, setProfileList] = useState<ProfileListState>({ kind: 'unloaded' });
  const listGeneration = useRef(0);

  /**
   * §4.8: a list refresh never changes the selected source — it only repaints
   * the options. Failures are bounded and leave the masthead fully usable
   * (the retained-option rule keeps the current source visible regardless).
   */
  const refreshProfileList = useCallback(async (): Promise<void> => {
    const gen = ++listGeneration.current;
    try {
      const result = parseGolemProfileListResult(await ListGolemProfiles());
      if (gen !== listGeneration.current) return;
      if (result.status === 'diagnostics') {
        setProfileList({
          kind: 'unavailable',
          message: formatProfileDiagnostic(result.diagnostics[0]),
        });
        return;
      }
      setProfileList({ kind: result.status, profiles: result.profiles });
    } catch {
      if (gen !== listGeneration.current) return;
      setProfileList({ kind: 'unavailable', message: TRANSPORT_UNAVAILABLE_COPY });
    }
  }, []);

  useEffect(() => {
    void refreshProfileList();
    return () => {
      listGeneration.current += 1;
    };
  }, [refreshProfileList]);

  // The tab mounts when it is opened and focused, so this lands the caret on the
  // surface the user just asked for rather than leaving it on the palette.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Teardown is terminal for keys (§3.2). It goes through the same reducer
  // table as every other outcome, so "were the values dropped?" has one answer.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(
    () => () => {
      settleDraft(draftRef.current, { kind: 'teardown' }, vault);
    },
    [vault]
  );

  // -------------------------------------------------------------------------
  // The one settle path
  // -------------------------------------------------------------------------

  /**
   * Records provenance, settles the draft, and replaces the visible outcome.
   * The three nonterminal results keep their key refs and their pending
   * request; every other event drops both and remounts the editors, because a
   * reset draft must not leave an editor holding fields staged against it.
   */
  /**
   * Remounts both cards, and clears the per-mount UI state that only made sense
   * for the document they were showing. A focus request left standing would be
   * REPLAYED by the fresh mount — re-expanding a row and stealing focus — so
   * every epoch bump goes through here rather than bumping the counter alone.
   */
  const resetCards = (): void => {
    setDraftEpoch((current) => current + 1);
    setFocusRequest(null);
    setSourceOpen(false);
  };

  const settle = (event: DraftEvent, next: Partial<WriteOutcome> = {}): void => {
    invalidateLoads();
    recordApplyProvenance(draftRef.current.source, event);
    setDraft((current) => settleDraft(current, event, vault));
    if (!retainsKeys(event)) {
      pendingRequestRef.current = null;
      resetCards();
    }
    setOutcome({ ...NO_OUTCOME, ...next });
    // The grant-only flow never reaches settle, but its own leftover notice
    // must not linger beside a settings-apply outcome that landed after it.
    setGrantNotice('');
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;

  const outcomeRef = useRef(outcome);
  outcomeRef.current = outcome;

  // The consent challenge outlives nothing: its own expiry is a terminal event.
  //
  // For a GRANT-ONLY prompt there is nothing to settle — no draft moved, no key
  // ref is at stake — so it arms no timer at all and simply lapses; the next
  // interaction with it is treated as a Cancel (spec D13, F17).
  useEffect(() => {
    const challenge = outcome.challenge;
    if (challenge === null || sending || outcome.intent === 'grant-only') return;
    const expire = () => {
      if (sendingRef.current) return;
      settleRef.current({ kind: 'expired' }, { notice: CHALLENGE_EXPIRED });
    };
    const delay = challenge.expiresAt - Date.now();
    if (delay <= 0) {
      expire();
      return;
    }
    const timer = setTimeout(expire, delay);
    return () => clearTimeout(timer);
  }, [outcome.challenge, outcome.intent, sending]);

  // -------------------------------------------------------------------------
  // Editors
  // -------------------------------------------------------------------------

  const stage = useCallback(
    (changes: Change[], drop: string[]) => {
      setDraft((current) => {
        const cleared = drop.reduce((next, id) => unstageChange(next, id, vault), current);
        return changes.reduce((next, change) => stageChange(next, change, vault), cleared);
      });
    },
    [vault]
  );

  const noteUnstaged = useCallback((rowKey: string, unstaged: boolean) => {
    setUnstagedEditors((current) => {
      if (current.has(rowKey) === unstaged) return current; // no render, no churn
      const next = new Set(current);
      if (unstaged) next.add(rowKey);
      else next.delete(rowKey);
      return next;
    });
  }, []);

  // -------------------------------------------------------------------------
  // Destructive transitions (§4.6a)
  // -------------------------------------------------------------------------

  const ask = useCallback(
    (next: Prompt) =>
      new Promise<boolean>((resolve) => {
        answerRef.current?.(false); // a superseded question answers itself
        answerRef.current = resolve;
        setPrompt(next);
      }),
    []
  );

  const answer = useCallback((ok: boolean) => {
    setPrompt(null);
    const resolve = answerRef.current;
    answerRef.current = null;
    resolve?.(ok);
  }, []);

  /** §4.6a: staged changes, an open row with unstaged edits, or a challenge. */
  const unsaved = isDraftDirty(draft) || unstagedEditors.size > 0 || outcome.challenge !== null;
  const unsavedRef = useRef(unsaved);
  unsavedRef.current = unsaved;

  /**
   * A challenge-state transition first calls and awaits the cancel; a
   * cancellation failure keeps the surface open rather than dropping a token
   * the backend still honours (§4.6a).
   */
  const cancelChallenge = async (): Promise<boolean> => {
    const token = outcomeRef.current.challenge?.token;
    if (token === undefined) return true;
    if (!beginOperation()) return false;
    const run = (async () => {
      try {
        parseCancelSettingsApplyResult(await CancelGolemSettingsApply(token));
        return true;
      } catch {
        setOutcome((current) => ({ ...current, notice: CANCEL_FAILED }));
        return false;
      } finally {
        endOperation();
      }
    })();
    writeRef.current = run.then(() => undefined);
    return run;
  };

  /**
   * Confirm, then cancel any challenge. Callers only reach it while dirty
   * (`unsaved`), which a grant-only prompt satisfies on its own even with a
   * clean draft and no unstaged editors — in that one case there is nothing
   * staged to discard, only an approval to cancel, so the dialog says that
   * instead of the standard discard copy.
   */
  const clearForTransition = async (title: string, confirmLabel: string): Promise<boolean> => {
    const challenge = outcomeRef.current.challenge;
    const grantOnlyCancel =
      challenge !== null &&
      outcomeRef.current.intent === 'grant-only' &&
      !isDraftDirty(draft) &&
      unstagedEditors.size === 0;
    const dialog = grantOnlyCancel
      ? { title: CANCEL_GRANT_TITLE, body: CANCEL_GRANT_BODY, confirmLabel: CANCEL_GRANT_CONFIRM }
      : { title, body: challenge === null ? DISCARD_BODY : DISCARD_BODY_CHALLENGED, confirmLabel };
    if (!(await ask(dialog))) return false;
    return cancelChallenge();
  };
  const clearForTransitionRef = useRef(clearForTransition);
  clearForTransitionRef.current = clearForTransition;

  // Registered once: the object reads refs, so the panes that can close this
  // surface never hold a stale closure — and never hold draft or key data.
  const closeHandler = useRef({
    hasUnsavedWork: () => unsavedRef.current,
    confirm: async (intent: ConfigCloseIntent): Promise<boolean> => {
      // The backend has torn down nothing yet, so waiting out an in-flight
      // settings RPC is safe and is what §4.6a requires before any decision.
      await writeRef.current.catch(() => undefined);
      if (!unsavedRef.current) return true; // clean: acknowledge, no dialog
      const confirmLabel = intent === 'quit' ? 'Discard & quit' : 'Discard & close';
      const ok = await clearForTransitionRef.current(
        'Discard your staged configuration changes?',
        confirmLabel
      );
      if (!ok) return false;
      settleRef.current({ kind: 'teardown' });
      return true;
    },
  });

  useEffect(() => {
    registerConfigCloseHandler(closeHandler.current);
    return () => registerConfigCloseHandler(null);
  }, []);

  /**
   * §3.3: Discard "invalidates a pending settings challenge", which makes it
   * one of §4.6a's cancel-then-transition paths — the token dies before the
   * draft does, and a failed cancellation keeps the surface exactly as it is
   * rather than abandoning a token the backend still honours. It needs no
   * confirmation of its own: pressing Discard IS the confirmation.
   *
   * Resolves false when the challenge could not be cancelled and the draft was
   * therefore left standing, so a caller that chains work onto it can stop.
   */
  const discard = async (): Promise<boolean> => {
    if (!(await cancelChallenge())) return false;
    settle({ kind: 'discard' });
    setPreview(null);
    setSourceError('');
    return true;
  };

  const refresh = async () => {
    if (!unsavedRef.current) {
      await load(true);
      void refreshProfileList();
      return;
    }
    if (!(await clearForTransition('Discard your staged changes and reload?', 'Discard & reload')))
      return;
    settle({ kind: 'discard' });
    setPreview(null);
    await load(true);
    void refreshProfileList();
  };

  // -------------------------------------------------------------------------
  // Sources (§4.6 bootstrap, §5.3)
  // -------------------------------------------------------------------------

  /** Resolves true only when the preview actually landed. */
  const adoptProfile = async (profileId: string, keepDraft: boolean): Promise<boolean> => {
    // §4.8: a failed selection returns to the PRIOR source, not Applied. The
    // settle below is the authorized §4.6a discard (edits and keys stay
    // dropped); only the source identity and its clean preview are restored.
    const priorSource = draftRef.current.source;
    const priorPreview = preview;
    if (!keepDraft) {
      settle({ kind: 'discard' });
      setPreview(null);
    }
    const gen = ++generation.current;
    setInFlight(false);
    setFocusRequest(null);
    setSourceLoading(true);
    setSourceError('');
    const restorePriorSource = (): void => {
      if (keepDraft) return; // the conflict-reload path never discarded anything
      setPreview(priorPreview);
      setDraft((current) => ({ ...current, source: priorSource }));
      resetCards();
    };
    try {
      const result = parseGolemProfileLoadResult(await LoadGolemProfile(profileId));
      if (gen !== generation.current) return false;
      if (result.status === 'diagnostics') {
        setSourceError(formatProfileDiagnostic(result.diagnostics[0]));
        restorePriorSource();
        return false;
      }
      const source = {
        kind: 'profile' as const,
        profileId: result.profileId,
        sourceRevision: result.sourceRevision,
      };
      setPreview(result.projection);
      // A conflict reload keeps the draft under review; a fresh choice clears
      // it through the one terminal path (§4.6a).
      setDraft((current) => ({ ...current, source }));
      // Either way the document the editors derive from has just been replaced,
      // so they re-derive: a row reopened against the old preview would read
      // back a stale model as if the user had chosen it.
      resetCards();
      return true;
    } catch (err) {
      if (gen !== generation.current) return false;
      setSourceError(boundedGolemMessage(err));
      restorePriorSource();
      return false;
    } finally {
      if (gen === generation.current) setSourceLoading(false);
    }
  };

  const startFromProfile = async () => {
    if (
      unsavedRef.current &&
      !(await clearForTransition(
        'Discard your staged changes and switch source?',
        'Discard & switch'
      ))
    )
      return;
    await adoptProfile(CURATED_PROFILE, false);
  };

  const startBlank = async () => {
    if (
      unsavedRef.current &&
      !(await clearForTransition(
        'Discard your staged changes and switch source?',
        'Discard & switch'
      ))
    )
      return;
    settle({ kind: 'discard' });
    setSourceError('');
    setPreview(BLANK_PREVIEW);
    setDraft((current) => ({ ...current, source: { kind: 'blank' } }));
  };

  /** §4.8 source switching. The select's value derives from draft.source, so a
   *  refused guard or failed load never moves it — React re-renders the prior
   *  value and the transient native choice is discarded. */
  const selectSource = async (value: string): Promise<void> => {
    const current =
      draft.source.kind === 'applied'
        ? APPLIED_SOURCE_VALUE
        : draft.source.kind === 'blank'
          ? BLANK_SOURCE_VALUE
          : draft.source.profileId;
    if (value === current || value === BLANK_SOURCE_VALUE) return;
    if (
      unsavedRef.current &&
      !(await clearForTransition(
        'Discard your staged changes and switch source?',
        'Discard & switch'
      ))
    )
      return;
    if (value === APPLIED_SOURCE_VALUE) {
      await discard();
      return;
    }
    await adoptProfile(value, false);
  };

  // -------------------------------------------------------------------------
  // The write itself (§5.2)
  // -------------------------------------------------------------------------

  const projection = phase.kind === 'ready' ? phase.projection : null;
  const body: Body | null = preview ?? projection;
  const mode: ApplyMode = projection?.state === 'missing' ? 'create' : 'apply';

  const projected = useMemo(
    () => projectDraft(body ?? { routes: [], models: [] }, draft),
    [body, draft]
  );

  const receive = (result: SettingsApplyResult): void => {
    switch (result.status) {
      case 'applied':
        settle(
          { kind: 'result', result },
          { notice: result.warning === undefined ? APPLIED : APPLIED_UNCERTAIN }
        );
        setPreview(null);
        setPhase({ kind: 'ready', projection: result.projection, busyNotice: false });
        return;
      case 'consent_required':
        settle({ kind: 'result', result }, { challenge: result.challenge });
        return;
      case 'drop_confirmation_required':
        settle({ kind: 'result', result }, { drops: result.drops });
        return;
      case 'conflict':
        settle(
          { kind: 'result', result },
          { conflict: result.conflict, notice: consentCopy(result.consentOutcome) }
        );
        return;
      case 'diagnostics':
        settle(
          { kind: 'result', result },
          { diagnostics: result.diagnostics, notice: consentCopy(result.consentOutcome) }
        );
        return;
      case 'busy':
        if (
          outcomeRef.current.challenge !== null &&
          outcomeRef.current.challenge.expiresAt <= Date.now()
        ) {
          settle({ kind: 'expired' }, { notice: CHALLENGE_EXPIRED });
          return;
        }
        // §5.2: Busy is the only NONTERMINAL confirmation result — it leaves the
        // token and the key refs retryable. Carrying the challenge forward is
        // what makes that true on this side: drop it and the panel vanishes,
        // Retry falls back to Call 1, and the user re-approves a destination
        // the backend has already been asked about.
        settle(
          { kind: 'result', result },
          { busy: true, challenge: outcomeRef.current.challenge, notice: BUSY_NOTICE }
        );
        return;
      case 'limited':
        settle(
          { kind: 'result', result },
          { diagnostics: result.diagnostics, notice: LIMITED_NOTICE }
        );
        return;
    }
  };

  /**
   * §5.2: an Apply/Confirm rejection is NOT a retryable domain result — the
   * response may have been lost after the save. A malformed response is the
   * same situation for the same reason: the outcome is unknown either way.
   */
  const send = (call: () => Promise<unknown>, token: string | null): void => {
    if (!beginOperation()) return;
    const run = (async () => {
      try {
        receive(parseSettingsApplyResult(await call()));
      } catch {
        // One best-effort cancel for a known token; failure is ignored locally
        // and the backend record expires normally.
        if (token !== null) void CancelGolemSettingsApply(token).catch(() => undefined);
        // The recovery panel below carries the copy; a second notice saying the
        // same sentence would only make the surface louder, not clearer.
        settleRef.current({ kind: 'rejected' }, { unknown: true });
        setPreview(null);
      } finally {
        endOperation();
      }
    })();
    writeRef.current = run;
  };

  const dispatchRequest = (request: SettingsApplyRequest): void => {
    const payload = request as unknown as ai.SettingsApplyRequest;
    send(
      () => (mode === 'create' ? CreateGolemSettings(payload) : ApplyGolemSettings(payload)),
      null
    );
  };

  const apply = () => {
    if (body === null) return;
    let request: SettingsApplyRequest;
    try {
      request = buildApplyRequest({ routes: body.routes, models: body.models }, draft, vault, mode);
    } catch {
      // A drafting bug the transport refuses: a local refusal, never a call.
      setOutcome({ ...NO_OUTCOME, notice: BUILD_REFUSED });
      return;
    }
    pendingRequestRef.current = request;
    dispatchRequest(request);
  };

  // -------------------------------------------------------------------------
  // Grant-only approval (spec D13, I15)
  //
  // The rule that shapes every function here: this flow approves destinations
  // for the ACTIVE configuration and writes no document, so it must never reach
  // `settle` — which means it never reaches `settleDraft` and never clears the
  // key vault. The staged draft and every key ref the user has entered survive
  // Confirm, Cancel, and a lapsed prompt alike (F17).
  // -------------------------------------------------------------------------

  /** A prompt the user left standing past its deadline. */
  const lapsed = (challenge: ApplyChallenge): boolean => challenge.expiresAt <= Date.now();

  /**
   * Revokes the token — it must not linger for its TTL (R3/I18) — and dismisses
   * the prompt. A cancellation that failed leaves the panel exactly where it is,
   * the same rule the settings flow follows.
   */
  const dismissGrants = async (notice: string): Promise<void> => {
    if (!(await cancelChallenge())) return;
    setOutcome(NO_OUTCOME);
    setGrantNotice(notice);
  };

  /** One grant RPC. Every landing is a `setOutcome`, never a `settle`. */
  const sendGrants = (call: () => Promise<unknown>, token: string | null): void => {
    if (!beginOperation()) return;
    const run = (async () => {
      try {
        const { status, challenge } = parseDestinationGrantsResult(await call());
        // The challenge is present iff the status is consent_required, so this
        // one branch covers both without a second, contradictable check.
        if (challenge !== undefined) {
          setOutcome({ ...NO_OUTCOME, challenge, intent: 'grant-only' });
          setGrantNotice('');
          return;
        }
        // Busy consumed nothing: the token stays retryable, so the prompt stays
        // up and its own Confirm is the retry. Every other status spent it.
        if (status !== 'busy') setOutcome(NO_OUTCOME);
        setGrantNotice(GRANT_NOTICE[status]);
      } catch (err) {
        // The approval outcome is unknown; preserve the draft and best-effort
        // cancel any known challenge.
        if (token !== null) void CancelGolemSettingsApply(token).catch(() => undefined);
        setOutcome(NO_OUTCOME);
        setGrantNotice(boundedGolemMessage(err));
      } finally {
        endOperation();
      }
    })();
    writeRef.current = run;
  };

  /** Call 1, fresh on every click: there is no subscription to keep it warm. */
  const approveDestinations = (): void => {
    setGrantNotice('');
    sendGrants(() => PrepareGolemDestinationGrants(), null);
  };

  const confirmDestination = () => {
    const challenge = outcome.challenge;
    if (challenge === null) return;
    if (outcome.intent === 'grant-only') {
      if (lapsed(challenge)) void dismissGrants(GRANT_EXPIRED);
      else sendGrants(() => ConfirmGolemDestinationGrants(challenge.token), challenge.token);
      return;
    }
    const request = pendingRequestRef.current;
    if (request === null) return;
    send(
      () =>
        ConfirmGolemSettingsApply({
          challengeToken: challenge.token,
          request,
        } as unknown as ai.ConfirmSettingsApplyRequest),
      challenge.token
    );
  };

  const retry = () => {
    if (outcome.challenge !== null) {
      confirmDestination();
      return;
    }
    const request = pendingRequestRef.current;
    if (request === null) apply();
    else dispatchRequest(request);
  };

  const cancelDestination = async () => {
    const { challenge, intent } = outcomeRef.current;
    if (challenge !== null && intent === 'grant-only') {
      await dismissGrants(lapsed(challenge) ? GRANT_EXPIRED : GRANT_CANCELLED);
      return;
    }
    if (await cancelChallenge()) settle({ kind: 'cancelled' }, { notice: CHALLENGE_CANCELLED });
  };

  /**
   * §5.2: the frontend discloses the dropped fields and re-stages that change
   * with the backend's exact set. The user still presses Apply — nothing is
   * resent on their behalf.
   */
  const restageDrops = () => {
    const sets = outcome.drops ?? [];
    setDraft((current) =>
      sets.reduce((next, set) => {
        const change = next.changes.find((staged) => changeStableID(staged) === set.changeId);
        return change?.kind === 'route'
          ? stageChange(next, { ...change, confirmDrops: set.fields }, vault)
          : next;
      }, current)
    );
    setOutcome(NO_OUTCOME);
  };

  /**
   * The conflict panel is the only way back from a conflict, so it survives a
   * reload that did not land — a busy or failed reload leaves the draft
   * stranded with `Needs review` rows and no action otherwise. Same shape as
   * `recover`: clear the outcome only once the reload actually succeeded.
   */
  const reviewConflict = async () => {
    const kind = outcome.conflict;
    if (kind === 'profile_source') {
      const source = draftRef.current.source;
      if (source.kind !== 'profile') return;
      if (await adoptProfile(source.profileId, true)) setOutcome(NO_OUTCOME);
      return;
    }
    if (kind === 'target') {
      if (await load(true)) setOutcome(NO_OUTCOME);
      return;
    }
    // A `challenge` conflict has nothing to reload — no document moved, and the
    // token is already spent — so `Return to draft` dismisses the panel and
    // hands the retained `Needs review` rows back for re-staging. The next
    // Apply mints a fresh challenge, which is exactly the recovery §4.6a wants.
    setOutcome(NO_OUTCOME);
  };

  const discardConflict = async () => {
    // A discard that could not cancel its challenge left the draft standing;
    // reloading on top of it would show a fresh document under changes the user
    // still holds.
    if (await discard()) await load(true);
  };

  const recover = async () => {
    // Busy or another transport failure keeps the recovery state, and the old
    // request is never resent (§5.2).
    if (await load(true)) setOutcome(NO_OUTCOME);
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const recovery = outcome.unknown;
  /**
   * §4.6a: while challenged, the only enabled draft actions are Confirm,
   * Cancel, and the cancel-then-transition paths (Discard, Refresh, source
   * switch, tab close, quit). Everything the request is made of — editors,
   * chips, and Apply — is frozen, because the visible request is what the
   * challenge token is bound to. Bootstrap source switches stay available as
   * cancel-then-transition paths and use the narrower lock below.
   *
   * A Busy result holds the surface for the same reason: §5.2 keeps that exact
   * request retryable, and Retry resends the RETAINED bytes. An edit made
   * beside the Retry button would be invisible to it and then erased by the
   * settle of a write that never carried it. Locking the request is one
   * condition in one place; clearing the retained request on every draft
   * mutation would be the same invariant restated at every mutation site.
   */
  const locked =
    inFlight || sourceLoading || sending || recovery || outcome.busy || outcome.challenge !== null;
  const sourceLocked = inFlight || sourceLoading || sending || recovery || outcome.busy;
  const changeCount = draftChangeCount(draft);
  // Editing needs a document that is both loaded and writable. A profile or
  // blank source supplies its own: the draft is layered on THAT preview.
  const canEdit =
    body !== null && body.state === 'ready' && body.editable && !body.readOnly && !locked;

  // A provider a defined model still references cannot be removed.
  const usedProviders = body?.models.map((entry) => entry.provider) ?? [];
  // Providers this draft is creating, projected from the staged adds. The
  // providers card renders one strip each so they can be reopened, corrected,
  // and unstaged; the routing card needs them because a route must be able to
  // name one — the blank builder is exactly one provider-add plus one route
  // (§5.2), and neither half exists in the document yet.
  const stagedProviders: ProviderProjection[] = draft.changes
    .filter((change) => change.kind === 'provider-add')
    .map((change) => ({
      name: change.name,
      endpoint: change.endpoint,
      classification: 'unknown',
      apiFormat: change.apiFormat ?? 'openai-compat',
      credentialState: 'none',
    }));
  const routableProviders = [...(body?.providers ?? []), ...stagedProviders];

  // A diagnostic about a provider or a use case that has a row belongs inside
  // that row (§4.3b, §4.3); one naming an entity this projection does not show
  // stays here, where it is still readable. Apply-result diagnostics route by
  // the same (subjectKind, subjectName) tuple as loaded ones.
  const diagnostics = [...(body?.diagnostics ?? []), ...outcome.diagnostics];
  const providerRows = new Set(body?.providers.map((entry) => entry.name) ?? []);
  const ownedByRow = (diagnostic: SettingsDiagnostic): boolean =>
    (diagnostic.subjectKind === 'provider' && providerRows.has(diagnostic.subjectName)) ||
    routingOwnsDiagnostic(body?.routes ?? [], diagnostic);
  const pageDiagnostics = diagnostics.filter((entry) => !ownedByRow(entry));

  // A profile source with no row changes is a complete write on its own — the
  // loaded, scrubbed profile document is the change — so nothing gates it here.
  const blocked =
    unstagedEditors.size > 0
      ? UNSTAGED_GATE
      : draft.needsReview.length > 0
        ? REVIEW_GATE
        : draft.source.kind === 'blank' && !bootstrapComplete(projected.changes)
          ? BOOTSTRAP_GATE
          : null;

  return (
    <div className={styles.root}>
      <div className={styles.page}>
        <header className={styles.masthead} data-testid="golem-config-masthead">
          <h2 ref={headingRef} tabIndex={-1} className={styles.title}>
            Golem Configuration
          </h2>
          {projection && (
            <>
              <StatusText tone={STATE_TONE[projection.state]}>
                {STATE_LABEL[projection.state]}
              </StatusText>
              {/* §4.2: the projection state is the document's; a dirty draft
                  overlays `Modified` beside it, in the same dot+text grammar
                  the rows use, so one vocabulary reads at both scales. */}
              {isDraftDirty(draft) && <StatusText tone="warn">Modified</StatusText>}
              <span className={styles.source}>{ORIGIN_LABEL[projection.sourceOrigin]}</span>
              {projection.revision !== undefined && (
                <span className={styles.revision} title={projection.revision}>
                  rev {projection.revision.slice(0, REVISION_HEAD)}
                </span>
              )}
            </>
          )}
          <span className={styles.grow} />
          {(() => {
            const selectModel = buildProfileSelectModel({
              source: draft.source,
              list: profileList,
              provenance: readActiveProfile(),
              appliedRevision: projection?.revision,
              state: projection?.state ?? null,
            });
            return (
              <span className={styles.profileSource}>
                <label className={styles.srOnly} htmlFor="golem-profile-select">
                  Configuration source
                </label>
                <select
                  id="golem-profile-select"
                  className={styles.profileSelect}
                  value={selectModel.value}
                  disabled={projection === null || sourceLocked}
                  aria-describedby={
                    selectModel.description !== '' ? 'golem-profile-select-desc' : undefined
                  }
                  onChange={(event) => void selectSource(event.target.value)}
                >
                  <option value={selectModel.applied.value}>{selectModel.applied.label}</option>
                  {selectModel.blank !== null && (
                    <option value={selectModel.blank.value}>{selectModel.blank.label}</option>
                  )}
                  {selectModel.retained !== null && (
                    <option value={selectModel.retained.value} disabled>
                      {selectModel.retained.label}
                    </option>
                  )}
                  {selectModel.curated.length > 0 && (
                    <optgroup label="Curated">
                      {selectModel.curated.map((option) => (
                        <option key={option.value} value={option.value} disabled={option.disabled}>
                          {option.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {selectModel.yours.length > 0 && (
                    <optgroup label="Yours">
                      {selectModel.yours.map((option) => (
                        <option key={option.value} value={option.value} disabled={option.disabled}>
                          {option.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                {sourceLoading && (
                  <span className={styles.selectDescription} role="status">
                    Loading profile…
                  </span>
                )}
                {selectModel.description !== '' && (
                  <span id="golem-profile-select-desc" className={styles.selectDescription}>
                    {selectModel.description}
                  </span>
                )}
              </span>
            );
          })()}
          {/* §4.1: profile management is absent, not disabled, in Slice B. The
              fixed bootstrap CTAs are the sole exception (§4.6). */}
          {projection?.state === 'missing' && !recovery && (
            <>
              <button
                type="button"
                className={styles.button}
                disabled={sourceLocked}
                onClick={() => void startFromProfile()}
              >
                Start from curated/local
              </button>
              <button
                type="button"
                className={styles.button}
                disabled={sourceLocked}
                onClick={() => void startBlank()}
              >
                Start blank
              </button>
            </>
          )}
          {recovery ? (
            <button
              type="button"
              className={styles.button}
              disabled={inFlight || sourceLoading || sending}
              onClick={() => void recover()}
            >
              Recover state
            </button>
          ) : (
            <button
              type="button"
              className={styles.button}
              disabled={inFlight || sourceLoading || sending}
              onClick={() => void refresh()}
            >
              Refresh
            </button>
          )}
          {/*
           * Permanent (spec I15): nothing probes for missing destinations on
           * mount and no event tells this surface when the set changes, so the
           * action is always offered and every click asks Call 1 afresh. It
           * needs a loaded document to have something to list against.
           */}
          <button
            type="button"
            className={styles.button}
            disabled={
              projection === null ||
              inFlight ||
              sourceLoading ||
              sending ||
              recovery ||
              // Locking remounts the editors, so their fields must be staged first.
              unstagedEditors.size > 0 ||
              outcome.challenge !== null ||
              // A settings-apply disclosure is still on screen: the dropped-
              // fields panel is the ONLY copy of `outcome.drops` (restageDrops
              // reads it), and a busy Retry keeps a request retryable. A fresh
              // Prepare here would replace the whole outcome and destroy either
              // one, so the action stays off until the user has resolved it.
              outcome.drops !== null ||
              outcome.busy ||
              outcome.conflict !== null
            }
            onClick={approveDestinations}
          >
            {APPROVE_ACTION}
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.quiet}`}
            disabled={sending}
            onClick={onClose}
          >
            Close
          </button>
        </header>

        {grantNotice !== '' && (
          <p className={styles.notice} role="status" data-testid="golem-grant-notice">
            {grantNotice}
          </p>
        )}

        <div className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
          {projection
            ? `Configuration ${STATE_LABEL[projection.state]}. Source ${ORIGIN_LABEL[projection.sourceOrigin]}.`
            : ''}
        </div>

        {phase.kind === 'loading' && <p className={styles.loading}>Loading configuration…</p>}

        {phase.kind === 'error' && (
          <div className={styles.error} role="alert">
            <p className={styles.errorText}>{phase.message}</p>
            <button
              type="button"
              className={styles.button}
              disabled={inFlight}
              onClick={() => void load(true)}
            >
              Retry
            </button>
          </div>
        )}

        {projection && body && (
          <div className={styles.body}>
            {phase.kind === 'ready' && phase.busyNotice && (
              <p className={styles.notice} data-tone="info" role="status">
                Golem is busy — a run or pending consent prompt is active. Showing the configuration
                currently in effect; refresh when idle.
              </p>
            )}

            {projection.state === 'missing' && preview === null && (
              <p className={styles.notice} data-tone="info">
                Start from the curated configuration or build a blank one — nothing is written until
                you Apply.
              </p>
            )}

            {EDITING_UNAVAILABLE[projection.state] !== undefined && (
              <p className={styles.notice} data-tone="caution">
                {EDITING_UNAVAILABLE[projection.state]}
              </p>
            )}

            {sourceError !== '' && (
              <p className={styles.notice} data-tone="blocking" role="alert">
                {sourceError}
              </p>
            )}

            {recovery && (
              <div className={styles.panel} data-tone="blocking" role="alert">
                <p className={styles.panelText}>{OUTCOME_UNKNOWN}</p>
                <p className={styles.panelText}>
                  Every retained change is waiting for review. Recover state reloads the active
                  configuration; re-stage what you still want before applying anything.
                </p>
              </div>
            )}

            {pageDiagnostics.length > 0 && (
              <ul className={styles.diagnostics} aria-label="Configuration diagnostics">
                {pageDiagnostics.map((diagnostic, index) => {
                  const { text, subject } = formatSettingsDiagnostic(
                    diagnostic.code,
                    diagnostic.subjectKind,
                    diagnostic.subjectName
                  );
                  return (
                    <li
                      key={`${diagnostic.code}-${diagnostic.subjectKind}-${diagnostic.subjectName}-${index}`}
                      className={styles.diagnostic}
                      data-tone={diagnostic.blocking ? 'blocking' : 'caution'}
                    >
                      <span className={styles.severity}>
                        {diagnostic.blocking ? 'Blocking' : 'Notice'}
                      </span>
                      <span className={styles.diagnosticText}>
                        {text}
                        {subject !== '' && (
                          <>
                            {' — '}
                            <span className={styles.subject}>{subject}</span>
                          </>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

            {sourceOpen && draft.source.kind !== 'applied' && (
              <div className={styles.panel} data-tone="info">
                <p className={styles.panelText}>
                  {draft.source.kind === 'blank'
                    ? 'This draft builds a new configuration from nothing. Applying it creates the file; the rows below are all pending.'
                    : `This draft comes from profile ${draft.source.profileId} at revision ${draft.source.sourceRevision.slice(0, REVISION_HEAD)}. Applying it replaces the active configuration, and every provider key it carries is cleared unless you stage a replacement.`}
                </p>
              </div>
            )}

            <ProvidersCard
              // Remount when the surface locks and on every document the open
              // editors could be diffing against. An editor derives its fields
              // once but stages against the live projection, so keeping it
              // mounted across a reload could re-stage stale values.
              key={`providers-${draftEpoch}:${projection.revision ?? ''}:${locked}`}
              providers={body.providers}
              usedProviders={usedProviders}
              changes={draft.changes}
              rows={projected.providerRows}
              diagnostics={diagnostics}
              stagedProviders={stagedProviders}
              vault={vault}
              editable={canEdit}
              focusRequest={focusRequest}
              onStage={stage}
              onUnstagedChange={noteUnstaged}
            />
            <RoutingCard
              // Same remount rule as the providers card: an open route editor
              // must not survive a lock or read stale values back as a choice.
              key={`routing-${draftEpoch}:${projection.revision ?? ''}:${locked}`}
              routes={body.routes}
              models={body.models}
              providers={routableProviders}
              draft={draft}
              // The COALESCED changes, never `draft.changes`: a row and a
              // reopened editor must show the selector-wide truth Apply sends
              // (§3.3), which is rebuilt from each group's last authority.
              changes={projected.changes}
              rows={projected.routeRows}
              roleRows={projected.roleRows}
              diagnostics={diagnostics}
              editable={canEdit}
              focusRequest={focusRequest}
              onStage={stage}
              onUnstagedChange={noteUnstaged}
            />

            {/*
             * The result of the last write, rendered where the control that
             * caused it lives. Above the cards these sat one or two screens up:
             * on a real configuration the Apply button is at the bottom of a
             * scrolled page, so every outcome — applied, busy, conflict, or a
             * local refusal — landed out of view and Apply read as doing nothing.
             */}
            {outcome.challenge !== null && (
              <div className={styles.panel} data-tone="caution" role="alert">
                <p className={styles.panelText}>
                  {promptLead(outcome.intent, outcome.challenge.destinations.length)} This is a
                  settings approval, separate from run approval.
                </p>
                {/* One line per destination, in the digest order the backend
                    sent, with the routing hops that reach it beneath. Every
                    entry is remote — a local destination never challenges —
                    and the lead sentence above already says so, so the row
                    itself does not repeat the classification. */}
                <ul className={styles.dropList}>
                  {outcome.challenge.destinations.map((destination) => (
                    <li key={`${destination.endpoint} ${destination.provider} ${destination.model}`}>
                      <p className={styles.destination}>
                        <span className={styles.value}>{destination.endpoint}</span>
                        <span aria-hidden="true">·</span>
                        <span className={styles.identifier}>{destination.provider}</span>
                        {/* Absent on a recommendation entry, which names a
                            provider and no model at all. */}
                        {destination.model !== '' && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className={styles.identifier}>{destination.model}</span>
                          </>
                        )}
                      </p>
                      <span className={styles.metaSub}>
                        {`Reached by ${destination.provenance.join(', ')}`}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className={styles.panelActions}>
                  <button
                    type="button"
                    className={`${styles.button} ${styles.primary}`}
                    disabled={inFlight || sourceLoading || sending}
                    onClick={confirmDestination}
                  >
                    Confirm destination
                  </button>
                  <button
                    type="button"
                    className={`${styles.button} ${styles.quiet}`}
                    disabled={inFlight || sourceLoading || sending}
                    onClick={() => void cancelDestination()}
                  >
                    Cancel approval
                  </button>
                </div>
              </div>
            )}

            {outcome.drops !== null && (
              <div className={styles.panel} data-tone="caution">
                <p className={styles.panelText}>
                  These changes remove model-specific settings the file authors. Confirm the exact
                  set and the changes are re-staged with it; nothing is written until you Apply.
                </p>
                <ul className={styles.dropList}>
                  {outcome.drops.map((drop) => (
                    <li key={drop.changeId} className={styles.panelText}>
                      {`${drop.changeId} → ${drop.fields.join(', ')}`}
                    </li>
                  ))}
                </ul>
                <div className={styles.panelActions}>
                  <button
                    type="button"
                    className={`${styles.button} ${styles.primary}`}
                    disabled={inFlight || sourceLoading || sending}
                    onClick={restageDrops}
                  >
                    Confirm and restage
                  </button>
                </div>
              </div>
            )}

            {outcome.conflict !== null && (
              <div className={styles.panel} data-tone="blocking" role="alert">
                <p className={styles.panelText}>
                  {outcome.conflict === 'challenge' ? CHALLENGE_CONFLICT : DOCUMENT_CONFLICT}
                </p>
                <div className={styles.panelActions}>
                  <button
                    type="button"
                    className={styles.button}
                    disabled={sending || inFlight || sourceLoading}
                    onClick={() => void reviewConflict()}
                  >
                    {outcome.conflict === 'challenge' ? 'Return to draft' : 'Reload & review draft'}
                  </button>
                  <button
                    type="button"
                    className={`${styles.button} ${styles.quiet}`}
                    disabled={sending || inFlight || sourceLoading}
                    onClick={() => void discardConflict()}
                  >
                    Discard draft
                  </button>
                </div>
              </div>
            )}

            {outcome.notice !== '' && (
              <p className={styles.notice} role="status">
                {outcome.notice}
              </p>
            )}

            {outcome.busy && (
              <div className={styles.panelActions}>
                <button
                  type="button"
                  className={styles.button}
                  disabled={inFlight || sourceLoading || sending}
                  onClick={retry}
                >
                  Retry
                </button>
              </div>
            )}

            {isDraftDirty(draft) && !recovery && (
              <ApplyBar
                source={draft.source}
                changes={projected.changes}
                count={changeCount}
                blocked={blocked}
                locked={locked}
                discardLocked={inFlight || sourceLoading || sending || recovery}
                onApply={apply}
                onDiscard={() => void discard()}
                onOpenChange={(changeId) =>
                  setFocusRequest((current) => ({ changeId, nonce: (current?.nonce ?? 0) + 1 }))
                }
                onOpenSource={() => setSourceOpen((current) => !current)}
              />
            )}
          </div>
        )}
      </div>

      {prompt !== null && <ConfirmDialog prompt={prompt} onAnswer={answer} />}
    </div>
  );
}

/**
 * The §4.6a confirmation: a native modal dialog, initially focused on the
 * non-destructive choice, cancelled by Escape, restoring focus to whatever
 * opened it. The same pattern the merge surface uses, for the same reason.
 */
function ConfirmDialog({ prompt, onAnswer }: { prompt: Prompt; onAnswer: (ok: boolean) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const invokerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const active = document.activeElement;
    invokerRef.current = active instanceof HTMLElement ? active : null;
    if (!dialog.open) dialog.showModal();
    keepRef.current?.focus();
  }, []);

  // §4.7: focus returns to the control that opened this, on both answers. A
  // control the answer itself removes (the tab's close button) is simply gone
  // by then, and the pane that removed it owns focus from there.
  const settleWith = (ok: boolean) => {
    const invoker = invokerRef.current;
    onAnswer(ok);
    if (invoker?.isConnected) invoker.focus();
  };

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="golem-config-confirm-title"
      aria-describedby="golem-config-confirm-body"
      onCancel={(event) => {
        event.preventDefault(); // Escape cancels the transition, not the draft
        settleWith(false);
      }}
    >
      <h2 id="golem-config-confirm-title" className={styles.dialogTitle}>
        {prompt.title}
      </h2>
      <p id="golem-config-confirm-body" className={styles.dialogBody}>
        {prompt.body}
      </p>
      <div className={styles.dialogActions}>
        <button
          ref={keepRef}
          type="button"
          className={`${styles.button} ${styles.quiet}`}
          onClick={() => settleWith(false)}
        >
          Keep editing
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          onClick={() => settleWith(true)}
        >
          {prompt.confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
