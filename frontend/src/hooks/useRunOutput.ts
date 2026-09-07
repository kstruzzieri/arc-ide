import { useEffect } from 'react';
import { AppendRunHistoryRecord, ClearAllRunHistory } from '../wails/bindings';
import { runhistory } from '../wails/bindings';
import { EventsOn } from '../wails/runtime';
import { mergeRunHistoryArchiveMaps, useIDEStore } from '../stores/ideStore';
import type {
  CompoundRunEvent,
  CompoundStep,
  OutputChunk,
  OutputEntry,
  RunState,
  RunStatusEvent,
} from '../types/runOutput';

const HISTORY_DRAIN_MS = 300;
const WAVEFORM_FLUSH_MS = 500;
const HISTORY_MAX_ENTRIES = 10_000;
const HISTORY_MAX_RECORD_BYTES = 10 << 20;
const HISTORY_RECORD_RESERVE_BYTES = 1024;
const ADMINISTRATIVE_STOP_REASONS = new Set(['workspace-switch', 'shutdown']);
const utf8Encoder = new TextEncoder();

type RunHistoryQueueGeneration = {
  active: boolean;
  tail: Promise<void>;
};

const newRunHistoryQueueGeneration = (): RunHistoryQueueGeneration => ({
  active: true,
  tail: Promise.resolve(),
});

let activeRunHistoryQueue = newRunHistoryQueueGeneration();
const pendingRunHistoryClears = new Set<Promise<unknown>>();

export function trackRunHistoryClear<T>(operation: Promise<T>): Promise<T> {
  pendingRunHistoryClears.add(operation);
  void operation.then(
    () => pendingRunHistoryClears.delete(operation),
    () => pendingRunHistoryClears.delete(operation)
  );
  return operation;
}

export async function waitForRunHistoryClears(): Promise<void> {
  while (pendingRunHistoryClears.size > 0) {
    await Promise.allSettled([...pendingRunHistoryClears]);
  }
}

function isTerminal(state: RunState | CompoundStep['state'] | undefined): boolean {
  return state === 'success' || state === 'failed' || state === 'stopped';
}

function isAdministrativeStop(reason: string | undefined): boolean {
  return reason != null && ADMINISTRATIVE_STOP_REASONS.has(reason);
}

export function enqueueRunHistoryRecord(record: runhistory.RecordInput): void {
  const acceptedAt = useIDEStore.getState();
  const workspacePath = acceptedAt.workspace?.path;
  const workspaceEpoch = acceptedAt.workspaceEpoch;
  const generation = activeRunHistoryQueue;

  generation.tail = generation.tail.then(async () => {
    if (!generation.active) return;
    try {
      const summary = await AppendRunHistoryRecord(record);
      if (!generation.active || !summary?.historyId) return;

      const current = useIDEStore.getState();
      if (current.workspace?.path !== workspacePath || current.workspaceEpoch !== workspaceEpoch) {
        return;
      }
      useIDEStore.setState((state) => mergeRunHistoryArchiveMaps(state, [summary]));
    } catch (err) {
      console.error('Failed to append run history:', err);
      const current = useIDEStore.getState();
      if (
        generation.active &&
        activeRunHistoryQueue === generation &&
        current.workspace?.path === workspacePath &&
        current.workspaceEpoch === workspaceEpoch
      ) {
        const message = err instanceof Error ? err.message : String(err);
        current.showToast(`Run history could not be saved: ${message}`, 'error');
      }
    }
  });
}

export function enqueueClearAllRunHistory(): Promise<void> {
  const generation = activeRunHistoryQueue;
  const clearing = generation.tail.then(() => ClearAllRunHistory());
  generation.tail = clearing.catch(() => undefined);
  return clearing;
}

export async function drainRunHistoryQueue(): Promise<void> {
  const generation = activeRunHistoryQueue;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const finished = await Promise.race([
      generation.tail.then(() => true),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, HISTORY_DRAIN_MS);
      }).then(() => false),
    ]);
    if (!finished && activeRunHistoryQueue === generation) {
      generation.active = false;
      activeRunHistoryQueue = newRunHistoryQueueGeneration();
    }
  } catch (err) {
    console.error('Failed to drain run history:', err);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function drainRunHistoryForClose(): Promise<void> {
  await drainRunHistoryQueue();
  await waitForRunHistoryClears();
}

function boundedUTF8String(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const width = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + width > maxBytes) break;
    bytes += width;
    end += character.length;
  }
  return end === value.length ? value : value.slice(0, end);
}

// Reports what was actually persisted alongside whether anything was dropped, so
// the archived record can be marked. Without the flag a partial log renders as a
// complete one and Diff invents a tail difference against a full run.
function persistenceEntries(
  entries: OutputEntry[],
  envelope: Record<string, unknown>
): { entries: OutputEntry[]; truncated: boolean } {
  let remaining =
    HISTORY_MAX_RECORD_BYTES -
    HISTORY_RECORD_RESERVE_BYTES -
    utf8Encoder.encode(JSON.stringify({ ...envelope, entries: [] })).byteLength;
  const persisted: OutputEntry[] = [];
  let truncated = false;

  for (let i = 0; i < entries.length && i < HISTORY_MAX_ENTRIES; i++) {
    const source = entries[i];
    const fixed = {
      stream: source.stream,
      text: '',
      timestamp: source.timestamp,
    };
    const fixedBytes = utf8Encoder.encode(JSON.stringify(fixed)).byteLength + 1;
    const textUnits = Math.floor((remaining - fixedBytes) / 6);
    if (textUnits <= 0) break;

    const entry = {
      ...fixed,
      text: boundedUTF8String(source.text, textUnits),
    };
    if (entry.text !== source.text) truncated = true;
    const entryBytes = utf8Encoder.encode(JSON.stringify(entry)).byteLength + 1;
    if (entryBytes > remaining) break;
    persisted.push(entry);
    remaining -= entryBytes;
  }
  // Covers both the budget breaking out early and the HISTORY_MAX_ENTRIES cap.
  return { entries: persisted, truncated: truncated || persisted.length < entries.length };
}

function ordinaryHistoryRecord(
  status: RunStatusEvent,
  startedAt: number,
  completedAt: number
): runhistory.RecordInput | undefined {
  const state = useIDEStore.getState();
  const output = state.runOutputs[status.runInstanceId];
  if (!output || output.state !== status.state) return undefined;
  const profile = state.runProfiles.find(({ id }) => id === status.profileId);
  const workingDir = output.workingDir ?? state.workspace?.path;
  const values = {
    kind: runhistory.RecordKind.RecordKindOrdinary,
    profileId: boundedUTF8String(status.profileId, 4 << 10),
    profileName: boundedUTF8String(profile?.name ?? status.profileId, 4 << 10),
    state: status.state,
    exitCode: status.exitCode,
    startedAt,
    completedAt,
    workspaceEpoch: status.workspaceEpoch ?? state.workspaceEpoch,
    ...(workingDir ? { workingDir: boundedUTF8String(workingDir, 32 << 10) } : {}),
  };

  const persisted = persistenceEntries(output.entries, values);
  return new runhistory.RecordInput({
    ...values,
    entries: persisted.entries,
    // The store ORs its own truncation into this, so the stored flag covers
    // output dropped on either side of the binding. The live buffer is itself
    // capped at MAX_OUTPUT_ENTRIES, so a run past that cap is already partial.
    truncated: persisted.truncated || output.truncated === true,
  });
}

function compoundStepHistoryRecord(
  step: CompoundStep,
  workspaceEpoch: number
): runhistory.RecordInput | undefined {
  if (!isTerminal(step.state) || step.startedAt == null || step.endedAt == null) {
    return undefined;
  }
  const record = new runhistory.RecordInput({
    kind: runhistory.RecordKind.RecordKindCompoundStep,
    profileId: boundedUTF8String(step.profileId, 4 << 10),
    profileName: boundedUTF8String(step.name || step.profileId, 4 << 10),
    state: step.state,
    exitCode: step.exitCode,
    startedAt: step.startedAt,
    completedAt: step.endedAt,
    workspaceEpoch,
  });
  delete record.workingDir;
  delete record.entries;
  return record;
}

export function useRunOutputListener(): void {
  useEffect(() => {
    const entryCounts = new Map<number, Map<string, number>>();
    const pendingCompoundEvents = new Map<string, CompoundRunEvent>();
    const cleanupPendingCompoundEvents = useIDEStore.subscribe((state, previous) => {
      if (state.runEventsPaused || state.workspaceEpoch !== previous.workspaceEpoch) {
        pendingCompoundEvents.clear();
      }
    });

    let waveformFlushTimer: ReturnType<typeof setTimeout> | undefined;
    const flushWaveform = () => {
      waveformFlushTimer = undefined;
      const store = useIDEStore.getState();
      if (!store.runEventsPaused) {
        for (const [profileId, count] of entryCounts.get(store.workspaceEpoch) ?? []) {
          store.updateWaveform(profileId, count);
        }
      }
      entryCounts.clear();
    };

    const applyCompoundEvent = (event: CompoundRunEvent) => {
      const before = useIDEStore.getState();
      const previous = before.runCompounds[event.compoundId];
      before.handleCompoundRun(event);
      const after = useIDEStore.getState();
      const accepted = after.runCompounds[event.compoundId];

      if (
        accepted === previous ||
        accepted?.runInstanceId !== event.runInstanceId ||
        accepted.state !== event.state
      ) {
        if (
          !before.runEventsPaused &&
          !isAdministrativeStop(event.reason) &&
          (event.workspaceEpoch == null || event.workspaceEpoch === before.workspaceEpoch) &&
          isTerminal(event.state) &&
          previous?.runInstanceId === event.runInstanceId &&
          !isTerminal(previous.state)
        ) {
          pendingCompoundEvents.set(event.runInstanceId, event);
        }
        return;
      }

      pendingCompoundEvents.delete(event.runInstanceId);
      if (isAdministrativeStop(event.reason)) return;

      const previousStates = new Map(previous?.steps.map((step) => [step.idx, step.state]) ?? []);
      for (const step of event.steps) {
        if (isTerminal(previousStates.get(step.idx)) || !isTerminal(step.state)) continue;
        const record = compoundStepHistoryRecord(
          step,
          event.workspaceEpoch ?? after.workspaceEpoch
        );
        if (record) enqueueRunHistoryRecord(record);
      }
    };

    const cleanupOutput = EventsOn('run:output', (chunk: OutputChunk) => {
      const store = useIDEStore.getState();
      const accepted = store.appendRunOutput(chunk);
      // Waveform tracks ordinary profiles only; compound step output has a parent.
      if (accepted && chunk.parentRunInstanceId == null) {
        const workspaceEpoch = chunk.workspaceEpoch ?? store.workspaceEpoch;
        const epochCounts = entryCounts.get(workspaceEpoch) ?? new Map<string, number>();
        epochCounts.set(chunk.profileId, (epochCounts.get(chunk.profileId) ?? 0) + 1);
        entryCounts.set(workspaceEpoch, epochCounts);
        waveformFlushTimer ??= setTimeout(flushWaveform, WAVEFORM_FLUSH_MS);
      }
    });

    const cleanupStatus = EventsOn('run:status', (status: RunStatusEvent) => {
      if (isAdministrativeStop(status.reason)) {
        pendingCompoundEvents.delete(status.runInstanceId);
      }
      const before = useIDEStore.getState();
      const previousOutput = before.runOutputs[status.runInstanceId];
      const previousCompound = before.runCompounds[status.profileId];
      const startedAt =
        before.runStartTimestamps[status.runInstanceId] ??
        before.runStartTimestamps[status.profileId];
      const completedAt = status.timestamp ?? Date.now();
      const isCompoundAggregate =
        before.runProfiles.some(
          (profile) => profile.id === status.profileId && profile.type === 'compound'
        ) || before.compoundIdByRunInstance[status.runInstanceId] != null;

      before.handleRunStatus(status);
      const after = useIDEStore.getState();
      if (isTerminal(status.state) && startedAt != null && !isAdministrativeStop(status.reason)) {
        if (isCompoundAggregate) {
          const compound = after.runCompounds[status.profileId];
          if (
            previousCompound?.runInstanceId === status.runInstanceId &&
            !isTerminal(previousCompound.state) &&
            compound?.runInstanceId === status.runInstanceId &&
            compound.state === status.state
          ) {
            const profile = after.runProfiles.find(({ id }) => id === status.profileId);
            const record = new runhistory.RecordInput({
              kind: runhistory.RecordKind.RecordKindCompoundAggregate,
              profileId: boundedUTF8String(status.profileId, 4 << 10),
              profileName: boundedUTF8String(profile?.name ?? status.profileId, 4 << 10),
              state: status.state,
              exitCode: status.exitCode,
              startedAt,
              completedAt,
              workspaceEpoch: status.workspaceEpoch ?? after.workspaceEpoch,
            });
            delete record.workingDir;
            delete record.entries;
            enqueueRunHistoryRecord(record);
          }
        } else if (
          previousOutput &&
          !isTerminal(previousOutput.state) &&
          after.runOutputs[status.runInstanceId]?.state === status.state
        ) {
          const record = ordinaryHistoryRecord(status, startedAt, completedAt);
          if (record) enqueueRunHistoryRecord(record);
        }
      }

      const pending = pendingCompoundEvents.get(status.runInstanceId);
      if (
        pending &&
        after.runCompounds[pending.compoundId]?.runInstanceId === status.runInstanceId &&
        after.runCompounds[pending.compoundId]?.state === pending.state
      ) {
        applyCompoundEvent(pending);
      }
    });

    const cleanupCompound = EventsOn('run:compound', applyCompoundEvent);

    return () => {
      cleanupOutput();
      cleanupStatus();
      cleanupCompound();
      cleanupPendingCompoundEvents();
      if (waveformFlushTimer !== undefined) clearTimeout(waveformFlushTimer);
    };
  }, []);
}
