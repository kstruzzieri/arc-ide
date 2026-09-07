import { useEffect } from 'react';
import { EventsOn } from '../wails/runtime';
import { GetRunHistorySnapshot, GetRunProfilesSnapshot, LoadRunProfiles } from '../wails/bindings';
import type { runhistory, runprofile } from '../wails/bindings';
import { useIDEStore } from '../stores/ideStore';
import { drainRunHistoryQueue, waitForRunHistoryClears } from './useRunOutput';
import type {
  ProfileSource,
  ProfileTag,
  ProfileType,
  RunProfile,
  RunProfileUIState,
} from '../types/runProfile';

const VALID_PROFILE_TYPES: ReadonlySet<string> = new Set(['single', 'compound']);
const VALID_PROFILE_SOURCES: ReadonlySet<string> = new Set(['user', 'detected']);
const VALID_PROFILE_TAGS: ReadonlySet<string> = new Set(['build', 'test', 'dev', 'deploy', 'lint']);
let runProfilesLoadTail: Promise<void> = Promise.resolve();

function asProfileType(value: unknown): ProfileType {
  return VALID_PROFILE_TYPES.has(value as string) ? (value as ProfileType) : 'single';
}

function asProfileSource(value: unknown): ProfileSource {
  return VALID_PROFILE_SOURCES.has(value as string) ? (value as ProfileSource) : 'detected';
}

function asTags(value: unknown): ProfileTag[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tags = value.filter(
    (tag): tag is ProfileTag => typeof tag === 'string' && VALID_PROFILE_TAGS.has(tag)
  );
  return tags.length > 0 ? tags : undefined;
}

function normalizeRunProfiles(rawProfiles: unknown): RunProfile[] {
  if (!Array.isArray(rawProfiles)) {
    return [];
  }

  const normalized: RunProfile[] = [];

  for (const rawProfile of rawProfiles) {
    if (!rawProfile || typeof rawProfile !== 'object') {
      continue;
    }

    const profile = rawProfile as runprofile.RunProfile;

    if (!profile.id || !profile.name) {
      continue;
    }

    normalized.push({
      id: profile.id,
      name: profile.name,
      type: asProfileType(profile.type),
      source: asProfileSource(profile.source),
      command: profile.command,
      workingDir: profile.workingDir,
      // The generated model types env values as possibly undefined; drop those
      // rather than widen the UI type.
      env:
        profile.env &&
        Object.fromEntries(
          Object.entries(profile.env).filter((e): e is [string, string] => e[1] !== undefined)
        ),
      envFile: profile.envFile,
      envVariants: profile.envVariants,
      activeVariant: profile.activeVariant,
      tags: asTags(profile.tags),
      steps: profile.steps,
      detectedFrom: profile.detectedFrom,
      order: profile.order,
      workspaceId: profile.workspaceId,
      workspaceName: profile.workspaceName,
      workspaceRelDir: profile.workspaceRelDir,
    });
  }

  return normalized;
}

export function normalizeProfileState(raw: unknown): Record<string, RunProfileUIState> {
  const out: Record<string, RunProfileUIState> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    out[id] = {
      adopted: v.adopted === true,
      lastRunAt: typeof v.lastRunAt === 'number' ? v.lastRunAt : 0,
    };
  }
  return out;
}

function normalizeSnapshot(raw: unknown): {
  profiles: RunProfile[];
  profileState: Record<string, RunProfileUIState>;
  workspaceEpoch?: number;
} {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    profiles: normalizeRunProfiles(obj.profiles),
    profileState: normalizeProfileState(obj.profileState),
    workspaceEpoch:
      typeof obj.workspaceEpoch === 'number' && obj.workspaceEpoch > 0
        ? obj.workspaceEpoch
        : undefined,
  };
}

/**
 * Hook to load and reactively update run profiles for a workspace.
 *
 * @param workspacePath - The workspace path. Pass null/undefined to skip loading.
 */
export function useRunProfilesLoader(workspacePath: string | null | undefined): void {
  // Re-running on the nonce is the recovery path for a failed load: it is the
  // only place runEventsPaused is cleared, so without it the run controls stay
  // disabled until the workspace changes.
  const reloadNonce = useIDEStore((s) => s.profilesReloadNonce);

  useEffect(() => {
    if (!workspacePath) {
      return;
    }

    useIDEStore.getState().pauseRunEvents();

    let cancelled = false;
    const { setProfilesLoading, setRunProfilesSnapshot, setProfilesError } = useIDEStore.getState();

    setProfilesLoading(true);

    const workflow = runProfilesLoadTail.then(async () => {
      if (cancelled) return;
      try {
        await drainRunHistoryQueue();
        if (cancelled) return;
        await waitForRunHistoryClears();
        if (cancelled) return;

        useIDEStore.getState().resetWorkspaceRunState();
        await LoadRunProfiles(workspacePath);
        if (cancelled) return;

        const [profileSnapshot, historyResult] = await Promise.all([
          GetRunProfilesSnapshot(),
          GetRunHistorySnapshot().then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason: unknown) => ({ status: 'rejected' as const, reason })
          ),
        ]);
        if (cancelled) return;

        const history =
          historyResult.status === 'fulfilled'
            ? (historyResult.value as runhistory.Snapshot)
            : undefined;
        const { profiles, profileState, workspaceEpoch } = normalizeSnapshot(profileSnapshot);
        setRunProfilesSnapshot(profiles, profileState, workspaceEpoch, history);
        if (historyResult.status === 'rejected') {
          const message =
            historyResult.reason instanceof Error
              ? historyResult.reason.message
              : String(historyResult.reason);
          useIDEStore.getState().showToast(`Run history unavailable: ${message}`, 'info');
        } else if (history?.warning) {
          useIDEStore.getState().showToast(history.warning, 'info');
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setProfilesError(message);
        }
      }
    });
    runProfilesLoadTail = workflow.catch(() => undefined);

    // Subscribe to reactive profile updates from the backend file watcher.
    // These events are emitted by the StartWatching callback in app.go when
    // a config file (package.json, go.mod, etc.) changes. The watcher must
    // be started separately (e.g., via useFileWatcher) for events to fire.
    const cleanup = EventsOn('runprofiles:changed', (snap: unknown) => {
      if (!cancelled) {
        const { profiles, profileState, workspaceEpoch } = normalizeSnapshot(snap);
        const state = useIDEStore.getState();
        if (state.runEventsPaused) return;
        if (workspaceEpoch == null && state.workspaceEpoch > 0) return;
        if (
          workspaceEpoch != null &&
          state.workspaceEpoch > 0 &&
          workspaceEpoch !== state.workspaceEpoch
        ) {
          return;
        }
        setRunProfilesSnapshot(profiles, profileState, workspaceEpoch);
      }
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [workspacePath, reloadNonce]);
}
