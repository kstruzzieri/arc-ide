import { useEffect, useMemo, useRef } from 'react';
import {
  computeProblemsProjection,
  useLSPStore,
  type ConflictDiagnosticSummary,
  type ProblemsProjection,
} from '../stores/lspStore';
import { useGitStore } from '../stores/gitStore';
import { useIDEStore } from '../stores/ideStore';
import { pathsReferToSameFile } from '../utils/lspUri';
import { joinRepoPath } from '../utils/paths';
import { GitConflictState } from '../wails/bindings';

type ConflictProjectionResult = ConflictDiagnosticSummary | { path: string; error: string } | null;

function useUnmergedFiles() {
  const status = useGitStore((state) => state.status);
  return useMemo(
    () => (status?.isRepo ? (status.files ?? []).filter((file) => file.unmerged) : []),
    [status]
  );
}

/**
 * Reads conflict state for every unmerged file and publishes the result to
 * the LSP store. Mount exactly once, from a component that never unmounts
 * (App): the Terminal panel unmounts when the bottom panel collapses, while
 * the StatusBar consumes the same projection and is always visible.
 */
export function useConflictProjectionSync() {
  const status = useGitStore((state) => state.status);
  const root = useGitStore((state) => state.root);
  const epoch = useGitStore((state) => state.epoch);
  const statusRevision = useGitStore((state) => state.statusRevision);
  const requestRevision = useRef(0);
  const lastFailureSignature = useRef<string | null>(null);
  const repoRoot = status?.isRepo ? status.repoRoot : null;
  const unmergedFiles = useUnmergedFiles();

  useEffect(() => {
    if (!status || !repoRoot || unmergedFiles.length === 0) {
      lastFailureSignature.current = null;
      return;
    }

    const revision = ++requestRevision.current;
    let cancelled = false;
    void Promise.all(
      unmergedFiles.map(async (file): Promise<ConflictProjectionResult> => {
        try {
          const state = await GitConflictState(repoRoot, file.path);
          // No snapshot (binary or whole-file topology) or no unresolved
          // regions: nothing to collapse — the raw diagnostics stand.
          const regions = state.snapshot?.regions ?? [];
          if (regions.length === 0) return null;
          return {
            filePath: joinRepoPath(repoRoot, file.path),
            repoRoot,
            repoPath: file.path,
            unresolvedRegionCount: regions.length,
            markerLineCount: regions.reduce((count, region) => count + (region.hasBase ? 4 : 3), 0),
          } satisfies ConflictDiagnosticSummary;
        } catch (error) {
          return {
            path: file.path,
            error: error instanceof Error ? error.message : String(error),
          } as const;
        }
      })
    ).then((results) => {
      const current = useGitStore.getState();
      if (
        cancelled ||
        requestRevision.current !== revision ||
        current.status !== status ||
        current.root !== root ||
        current.epoch !== epoch ||
        current.statusRevision !== statusRevision
      ) {
        return;
      }

      const conflicts: ConflictDiagnosticSummary[] = [];
      const failures: Array<{ path: string; error: string }> = [];
      for (const result of results) {
        if (!result) continue;
        if ('error' in result) failures.push(result);
        else conflicts.push(result);
      }
      useLSPStore.getState().setConflictRead({ repoRoot, epoch, conflicts });
      // A durable failure (oversized file, literal marker content) recurs on
      // every status refresh; re-toasting the identical message each time
      // would spam and stomp unrelated toasts. Toast only when it changes.
      if (failures.length === 0) {
        lastFailureSignature.current = null;
      } else {
        const failureSummary = failures
          .map((failure) => `${failure.path}: ${failure.error}`)
          .join('; ');
        const signature = JSON.stringify([repoRoot, epoch, failureSummary]);
        if (signature !== lastFailureSignature.current) {
          lastFailureSignature.current = signature;
          useIDEStore
            .getState()
            .showToast(`Could not read conflict state for ${failureSummary}`, 'error');
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [epoch, repoRoot, root, status, statusRevision, unmergedFiles]);
}

/**
 * The conflict-aware Problems view shared by the Problems panel and the
 * StatusBar. Derives synchronously from store state; the async git reads are
 * owned by useConflictProjectionSync.
 */
export function useProblemsProjection(): ProblemsProjection {
  const diagnostics = useLSPStore((state) => state.diagnostics);
  const read = useLSPStore((state) => state.conflictRead);
  const status = useGitStore((state) => state.status);
  const epoch = useGitStore((state) => state.epoch);
  const repoRoot = status?.isRepo ? status.repoRoot : null;
  const unmergedFiles = useUnmergedFiles();

  // Stale-while-revalidate: every refresh installs a new status object, so
  // requiring identity with the read here would drop the collapse — re-flooding
  // the panel with raw marker diagnostics — on each refresh until the re-read
  // lands. Keep the last read for this repository and filter it against the
  // CURRENT unmerged set instead: a file written clean disappears the moment
  // its status does, while still-conflicted files never flash.
  const conflicts = useMemo(
    () =>
      read && repoRoot && read.epoch === epoch && pathsReferToSameFile(read.repoRoot, repoRoot)
        ? read.conflicts.filter((conflict) =>
            unmergedFiles.some((file) =>
              pathsReferToSameFile(joinRepoPath(repoRoot, file.path), conflict.filePath)
            )
          )
        : [],
    [epoch, read, repoRoot, unmergedFiles]
  );

  return useMemo(() => computeProblemsProjection(diagnostics, conflicts), [conflicts, diagnostics]);
}
