/**
 * §4.8 `Save as profile…` button (#312): the ONE write action left once the
 * Actions menu's two bootstrap items (Start from curated ▸, Start blank)
 * moved to the Source picker's START FROM group. A plain masthead button
 * that opens straight onto the naming step — no idle menu step stands
 * between the click and the `Profile name` field. Escape closes and restores
 * the trigger, an outside pointer closes without stealing focus (§4.7).
 * Export and Delete are deferred (go-llm#537/#536) and deliberately absent —
 * not disabled placeholders.
 */
import { useEffect, useRef, useState } from 'react';
import type { GolemProfileSaveResult } from '../../types/golemConfig';
import { PROFILE_SLUG } from '../../types/golemConfig';
import { formatProfileDiagnostic } from '../../utils/settingsDiagnostics';
import { TRANSPORT_UNAVAILABLE_COPY } from './profileSelect';
import styles from './GolemConfig.module.css';

export type AcquireRevisionOutcome =
  | { kind: 'revision'; revision: string }
  | { kind: 'unloadable' }
  | { kind: 'transport' };

export interface SaveProfileButtonProps {
  /** '' when a Save may target the applied config; else the state refusal. */
  saveRefusal: string;
  /** '' when a CREATE is allowed; else the profile-limit refusal. §5.6 keeps
   *  replacement by exact id/revision available while the list is limited, so
   *  Overwrite gates on saveRefusal alone and ignores this on purpose. */
  createRefusal: string;
  /** The whole-surface lock (§4.8 write/consent/drop/busy/recovery states) —
   *  enforced on EVERY descendant and handler, not only the trigger. */
  disabled: boolean;
  /** The title shown while the trigger is disabled; '' when it is enabled. */
  reason: string;
  saving: boolean;
  /** The applied revision a Save would duplicate (undefined off-ready; the
   *  refusals gate every path that reads it). The overwrite tuple freezes the
   *  value current at ACQUISITION completion, read through a ref — see
   *  SaveStep and beginOverwrite. */
  appliedRevision: string | undefined;
  saveProfileAs: (
    id: string,
    revisions: { appliedRevision: string; expectedRevision?: string }
  ) => Promise<GolemProfileSaveResult>;
  acquireProfileRevision: (id: string) => Promise<AcquireRevisionOutcome>;
}

const PROFILE_SAVED = 'Profile saved.';
const PROFILE_SAVED_UNCERTAIN =
  'Profile saved. Golem could not confirm the write reached disk; check it after a restart.';
const SAVE_NAME_INVALID = 'That profile name is invalid.';
const SAVE_ACTIVE_CONFLICT = 'Configuration changed; Refresh and try again.';
const SAVE_TARGET_CONFLICT = 'The profile changed; reload and try again.';
const SAVE_COLLIDER_UNREADABLE =
  'That name is taken and the existing profile cannot be read. Choose another name, or repair the file outside Firn.';
/** [F5] The one cause the workspace's `reason` cannot name: this component's OWN
 *  in-flight flow (`pending`). The copy matches the workspace's `saving` case. */
const SAVE_IN_PROGRESS = 'A save is already in progress.';
const SAVE_OUTCOME_UNKNOWN =
  'The save result is unknown — the profile may already exist. Refresh the profile list before saving again.';

// Focus targets for the step-transition effect below — named once so the
// effect and the elements that carry the ids cannot drift apart.
const OVERWRITE_CONFIRM_ID = 'golem-profile-overwrite-confirm';
const NOTICE_DONE_ID = 'golem-profile-notice-done';
/** [K2] The trigger is a focus target like any other step control, so it is named here too. */
const SAVE_TRIGGER_ID = 'golem-profile-save';

type SaveStep =
  | { step: 'idle' }
  | { step: 'naming'; slug: string; fieldError: string }
  | {
      step: 'overwrite';
      slug: string;
      /**
       * The FROZEN §4.8 confirmation tuple (controller ruling, plan header):
       * expectedRevision is the acquired destination revision, appliedRevision
       * the applied revision current at acquisition. Nothing that happens
       * while this popover stands — Refresh included — is substituted in; the
       * confirmed Save sends exactly these, and an active_revision conflict
       * is then the honest outcome.
       */
      expectedRevision: string;
      appliedRevision: string;
      notice: string;
    }
  | { step: 'notice'; text: string };

export function SaveProfileButton({
  saveRefusal,
  createRefusal,
  disabled,
  reason,
  saving,
  appliedRevision,
  saveProfileAs,
  acquireProfileRevision,
}: SaveProfileButtonProps) {
  const [open, setOpen] = useState(false);
  const [save, setSave] = useState<SaveStep>({ step: 'idle' });
  /** In-flight bit for the WHOLE save flow — the RPC AND the collider
   *  acquisition — so no window exists where a stale continuation can land
   *  behind an apparently idle surface. */
  const [pending, setPending] = useState(false);
  /**
   * Every user transition out of the current step (Back, Done, close, a fresh
   * submission) bumps this; every async continuation re-checks it before any
   * setSave. A delayed acquisition or save response therefore lands in a dead
   * generation instead of resurrecting an abandoned flow (§4.8: a further
   * conflict requires FRESH confirmation — never a replayed one).
   */
  const flowGeneration = useRef(0);
  /**
   * The ruling freezes the ACQUISITION-time applied revision into the
   * overwrite tuple, and acquisition completes after an await — a render
   * closure read there (the create-dispatch capture, or confirmOverwrite's
   * prop) is STALE when a Refresh lands mid-acquisition. The ref always
   * carries the latest prop; beginOverwrite reads it exactly once, at the
   * moment acquisition completes.
   */
  const appliedRevisionRef = useRef(appliedRevision);
  appliedRevisionRef.current = appliedRevision;
  const rootRef = useRef<HTMLSpanElement>(null);
  /**
   * The announcement channel for the visible notice text, mirroring
   * RoutingCard's `announcement` state (line ~144 there). The live region it
   * feeds is rendered UNCONDITIONALLY below, outside `open &&` — a region
   * inserted together with its text is generally not announced by assistive
   * technology, so it must pre-exist for the button's whole lifetime and only
   * then receive text. This is an announcement CHANNEL only: the visible
   * notice copy stays exactly where it was.
   */
  const [announcement, setAnnouncement] = useState('');
  /** A fresh object per request, so a repeated transition to the same step
   *  focuses again (mirrors RoutingCard's `pendingFocus`). */
  const [pendingFocus, setPendingFocus] = useState<{ elementId: string } | null>(null);
  /** [N1] The element id of the request WAITING for its disabled target to come back. */
  const held = useRef<string | null>(null);
  const ownedElsewhere = (): boolean =>
    document.activeElement !== null && document.activeElement !== document.body;

  const invalidateFlow = () => {
    flowGeneration.current += 1;
    setPending(false);
  };

  const close = (restoreFocus: boolean) => {
    invalidateFlow();
    setOpen(false);
    setSave({ step: 'idle' });
    // [K2] Never a synchronous focus(): the trigger is DISABLED while a save is in
    // flight, so the call was a no-op and focus fell to <body>. The request goes
    // through the pendingFocus effect, which holds it until the trigger is
    // focusable again.
    if (restoreFocus) setPendingFocus({ elementId: SAVE_TRIGGER_ID });
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true);
    };
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        close(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
    // close is stable per render; the listeners re-bind only on open/close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Every notice, however it was produced (settleSaved, an active/target
  // conflict, an unreadable collider, a transport rejection…), announces
  // through this ONE effect rather than at each setSave call site — so no
  // future notice-producing path can forget the announcement. Leaving the
  // notice step clears it back to '', so a REPEATED identical notice text
  // still registers as a change for assistive technology.
  useEffect(() => {
    setAnnouncement(save.step === 'notice' ? save.text : '');
  }, [save]);

  // §4.8 availability, enforced on EVERY descendant and handler — not only the
  // trigger — so a restriction arriving while the popover is open (a list
  // refresh resolving limited, a projection transition) takes effect at once.
  // [K2] Declared above the focus effect, which depends on `createBlocked`.
  const flowBusy = disabled || saving || pending;
  const createBlocked = flowBusy || saveRefusal !== '' || createRefusal !== '';
  // §5.6: replacement by exact id/revision stays available while the list is
  // limited, so Overwrite gates on the state refusal alone — never the limit.
  const overwriteBlocked = flowBusy || saveRefusal !== '';

  // A step transition currently drops focus to <body> — nothing moves it —
  // so a keyboard user must Tab from the document start to reach the fresh
  // control. Mirrors RoutingCard's pendingFocus + focus effect exactly:
  // `setPendingFocus` is called SYNCHRONOUSLY alongside `setSave` at each
  // entry point below (gotoNotice; the trigger; beginOverwrite) — never
  // derived from a separate effect watching save.step. A derived effect adds
  // a second render/commit hop between "the step changed" and "focus moved",
  // and that extra hop raced a real keyboard interaction in testing: a
  // `Refresh` keypress landed while the stolen focus was still in flight and
  // silently hijacked it. Setting both states in the same synchronous block
  // lets React batch them into ONE commit, so the consuming effect below runs
  // focus() inside the SAME flush that puts the fresh step on screen.
  useEffect(() => {
    if (pendingFocus === null) return;
    const target = document.getElementById(pendingFocus.elementId);
    // [K2] A disabled control cannot take focus, and the save flow closes the
    // popover WHILE its own RPC is still in flight — so hold the request across
    // the commits that keep it disabled and spend it on the one that re-enables
    // it. `createBlocked` is that bit; the effect re-runs when it clears.
    if (target instanceof HTMLButtonElement && target.disabled) {
      // [N1] …but only while nothing else owns focus. Escape closes the popover
      // mid-save, and the user can reach an editor and start typing before the
      // RPC settles; a request held unconditionally would then yank focus back
      // here. Something else holding focus means the request is stale — drop it.
      if (ownedElsewhere()) {
        setPendingFocus(null);
        held.current = null;
      } else held.current = pendingFocus.elementId;
      return;
    }
    // [N1] A HELD request is spent on the commit that re-enables the target — which
    // is also the first commit that can observe a focus move made while it waited.
    // An immediate request (a step transition) is not subject to this: it fires in
    // the same flush as the change that produced it, and the control it leaves
    // behind — the trigger that opened the popover — is legitimately still focused.
    const stale = held.current === pendingFocus.elementId && ownedElsewhere();
    held.current = null;
    if (!stale) target?.focus();
    setPendingFocus(null);
  }, [pendingFocus, createBlocked]);

  /**
   * Enters the notice step AND focuses Done, in one synchronous call — every
   * notice-producing path below routes through this ONE function so none of
   * them can forget the focus move (mirrors the announcement effect's "one
   * place" rationale). See the pendingFocus effect above for why the two
   * setters must land together rather than through a derived effect.
   */
  const gotoNotice = (text: string) => {
    setSave({ step: 'notice', text });
    setPendingFocus({ elementId: NOTICE_DONE_ID });
  };

  const settleSaved = (result: Extract<GolemProfileSaveResult, { status: 'saved' }>) => {
    gotoNotice(result.warning === undefined ? PROFILE_SAVED : PROFILE_SAVED_UNCERTAIN);
  };

  /** §4.8: collision -> load WITHOUT staging, solely to capture the raw
   *  revision, then reveal the explicit second-step Overwrite bound to the
   *  frozen {id, expectedRevision, appliedRevision} tuple. Runs inside the
   *  caller's generation: a dead generation swallows the outcome. */
  const beginOverwrite = async (gen: number, slug: string, notice: string) => {
    const acquired = await acquireProfileRevision(`user/${slug}`);
    if (gen !== flowGeneration.current) return;
    if (acquired.kind === 'revision') {
      // Freeze the tuple NOW: the applied revision current at the moment
      // acquisition completed (controller ruling, plan header) — never the
      // create-dispatch capture and never a stale render closure. Readiness
      // lapsing mid-acquisition gets the honest active-conflict copy.
      const applied = appliedRevisionRef.current;
      if (applied === undefined) {
        gotoNotice(SAVE_ACTIVE_CONFLICT);
        return;
      }
      setSave({
        step: 'overwrite',
        slug,
        expectedRevision: acquired.revision,
        appliedRevision: applied,
        notice,
      });
      setPendingFocus({ elementId: OVERWRITE_CONFIRM_ID });
      return;
    }
    gotoNotice(
      acquired.kind === 'unloadable' ? SAVE_COLLIDER_UNREADABLE : TRANSPORT_UNAVAILABLE_COPY
    );
  };

  const submitName = async (slug: string) => {
    // The handler enforces availability, not only the disabled attribute.
    if (createBlocked || appliedRevision === undefined) return;
    // Client-side §5.6 grammar validation: an invalid id is an inline field
    // error and never crosses Wails (§4.8).
    if (!PROFILE_SLUG.test(slug)) {
      setSave({ step: 'naming', slug, fieldError: SAVE_NAME_INVALID });
      return;
    }
    // The CREATE confirms the applied revision current at its dispatch. An
    // overwrite this create grows into freezes its OWN tuple at acquisition
    // time inside beginOverwrite (controller ruling) — never this capture.
    const applied = appliedRevision;
    const gen = ++flowGeneration.current;
    setPending(true);
    try {
      // Create-only: {id, appliedRevision}, no expectedRevision (§4.8).
      const result = await saveProfileAs(`user/${slug}`, { appliedRevision: applied });
      if (gen !== flowGeneration.current) return;
      switch (result.status) {
        case 'saved':
          settleSaved(result);
          return;
        case 'conflict':
          if (result.conflict === 'active_revision') {
            gotoNotice(SAVE_ACTIVE_CONFLICT);
            return;
          }
          await beginOverwrite(gen, slug, '');
          return;
        case 'diagnostics':
          gotoNotice(formatProfileDiagnostic(result.diagnostics[0]));
          return;
      }
    } catch {
      // §4.8: a transport-rejected Save has an UNKNOWN outcome — its own
      // recovery notice, and never an automatic retry.
      if (gen !== flowGeneration.current) return;
      gotoNotice(SAVE_OUTCOME_UNKNOWN);
    } finally {
      if (gen === flowGeneration.current) setPending(false);
    }
  };

  const confirmOverwrite = async (frozen: Extract<SaveStep, { step: 'overwrite' }>) => {
    if (overwriteBlocked) return;
    const gen = ++flowGeneration.current;
    setPending(true);
    try {
      // The FROZEN tuple, verbatim (controller ruling): a Refresh that moved
      // the applied revision while this popover stood is answered by an honest
      // active_revision conflict, never a silent substitution.
      const result = await saveProfileAs(`user/${frozen.slug}`, {
        appliedRevision: frozen.appliedRevision,
        expectedRevision: frozen.expectedRevision,
      });
      if (gen !== flowGeneration.current) return;
      switch (result.status) {
        case 'saved':
          settleSaved(result);
          return;
        case 'conflict':
          if (result.conflict === 'active_revision') {
            gotoNotice(SAVE_ACTIVE_CONFLICT);
            return;
          }
          // §4.8: a further conflict re-runs acquisition and requires a FRESH
          // explicit confirmation, freezing a FRESH tuple — the applied
          // revision current when THAT acquisition completes (beginOverwrite
          // reads it from the ref then; a readiness lapse yields the honest
          // active-conflict copy there, never a dead tuple).
          await beginOverwrite(gen, frozen.slug, SAVE_TARGET_CONFLICT);
          return;
        case 'diagnostics':
          gotoNotice(formatProfileDiagnostic(result.diagnostics[0]));
          return;
      }
    } catch {
      if (gen !== flowGeneration.current) return;
      gotoNotice(SAVE_OUTCOME_UNKNOWN);
    } finally {
      if (gen === flowGeneration.current) setPending(false);
    }
  };

  return (
    <span className={styles.menuRoot} ref={rootRef}>
      <button
        type="button"
        id={SAVE_TRIGGER_ID}
        className={styles.button}
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled || createBlocked}
        title={disabled || createBlocked ? reason || SAVE_IN_PROGRESS : undefined}
        onClick={() => {
          if (open) {
            close(false);
            return;
          }
          if (createBlocked) return;
          setOpen(true);
          setSave({ step: 'naming', slug: '', fieldError: '' });
          setPendingFocus({ elementId: 'golem-profile-name' });
        }}
      >
        Save as profile…
      </button>
      {/* #263 follow-up: rendered unconditionally (outside `open &&`) so this
          region exists for the button's WHOLE lifetime, not only from the
          moment the notice step mounts — a region inserted together with its
          text is generally not announced by assistive technology. */}
      <span
        className={styles.srOnly}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="golem-profile-menu-announcement"
      >
        {announcement}
      </span>
      {open && (
        <div className={styles.menuPanel} role="group" aria-label="Save as profile">
          {save.step === 'naming' && (
            <form
              className={styles.menuForm}
              onSubmit={(event) => {
                event.preventDefault();
                void submitName(save.slug);
              }}
            >
              <p className={styles.menuHint}>
                Saves the applied configuration on disk as a named profile. Staged edits are not
                included until you Apply.
              </p>
              <label className={styles.fieldLabel} htmlFor="golem-profile-name">
                Profile name
              </label>
              <span className={styles.menuNameRow}>
                <span className={styles.menuNamePrefix} aria-hidden="true">
                  user/
                </span>
                <input
                  id="golem-profile-name"
                  // The surface's one control box (`.input`), plus the flex
                  // sizing that lets it share the row with the fixed prefix.
                  className={`${styles.input} ${styles.menuNameInput}`}
                  value={save.slug}
                  aria-invalid={save.fieldError !== '' || undefined}
                  aria-describedby={save.fieldError !== '' ? 'golem-profile-name-error' : undefined}
                  onChange={(event) =>
                    setSave({ step: 'naming', slug: event.target.value, fieldError: '' })
                  }
                />
              </span>
              {save.fieldError !== '' && (
                <p id="golem-profile-name-error" className={styles.fieldError} role="alert">
                  {save.fieldError}
                </p>
              )}
              {(saveRefusal !== '' || createRefusal !== '') && (
                <p className={styles.menuHint} role="alert">
                  {saveRefusal !== '' ? saveRefusal : createRefusal}
                </p>
              )}
              <span className={styles.menuActions}>
                <button type="submit" className={styles.button} disabled={createBlocked}>
                  Save
                </button>
                <button
                  type="button"
                  className={`${styles.button} ${styles.quiet}`}
                  onClick={() => close(true)}
                >
                  Back
                </button>
              </span>
            </form>
          )}
          {save.step === 'overwrite' && (
            <div className={styles.menuForm}>
              {save.notice !== '' && <p className={styles.menuHint}>{save.notice}</p>}
              <p className={styles.panelText}>
                {`A profile named user/${save.slug} already exists. Overwrite replaces it with the key-scrubbed applied configuration.`}
              </p>
              {saveRefusal !== '' && (
                <p className={styles.menuHint} role="alert">
                  {saveRefusal}
                </p>
              )}
              <span className={styles.menuActions}>
                <button
                  type="button"
                  id={OVERWRITE_CONFIRM_ID}
                  className={styles.button}
                  disabled={overwriteBlocked}
                  onClick={() => void confirmOverwrite(save)}
                >
                  Overwrite
                </button>
                <button
                  type="button"
                  className={`${styles.button} ${styles.quiet}`}
                  onClick={() => {
                    invalidateFlow();
                    setSave({ step: 'naming', slug: save.slug, fieldError: '' });
                    setPendingFocus({ elementId: 'golem-profile-name' });
                  }}
                >
                  Back
                </button>
              </span>
            </div>
          )}
          {save.step === 'notice' && (
            <div className={styles.menuForm}>
              {/* Visible copy only: the persistent region above (rendered for
                  the button's whole lifetime) is the one that announces — a
                  region created together with its text, as this `<p>` was
                  before, is generally not picked up by assistive technology. */}
              <p className={styles.panelText}>{save.text}</p>
              <button
                type="button"
                id={NOTICE_DONE_ID}
                className={styles.button}
                onClick={() => close(true)}
              >
                Done
              </button>
            </div>
          )}
        </div>
      )}
    </span>
  );
}
