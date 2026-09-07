import { useEffect, useState } from 'react';
import { GitFileAtRev } from '../wails/bindings';
import { useGitStore } from '../stores/gitStore';
import { classifyChange } from '../types/git';
import { joinRepoPath, normalizeFsPath } from '../utils/paths';

/**
 * HEAD content for the given absolute file path, feeding the editor's git
 * gutter. null = no markers (clean file, binary, no repo); '' = everything
 * is new (untracked/added file). Re-resolves when git status refreshes, so
 * markers reset after commits and stage/unstage of the whole file.
 */
export function useGitBaseline(absPath: string | undefined): string | null {
  const change = useGitStore((s) => {
    if (!absPath || !s.status?.isRepo) return undefined;
    const normPath = normalizeFsPath(absPath);
    const repoRoot = s.status.repoRoot;
    return (s.status.files ?? []).find(
      (f) => normalizeFsPath(joinRepoPath(repoRoot, f.path)) === normPath
    );
  });
  const rowStatus = change ? classifyChange(change).rowStatus : undefined;
  const repoRoot = useGitStore((s) => (s.status?.isRepo ? s.status.repoRoot : null));
  const statusRevision = useGitStore((s) => s.statusRevision);

  const relPath = (() => {
    if (!absPath || !repoRoot) return null;
    const normRoot = normalizeFsPath(repoRoot);
    const normPath = normalizeFsPath(absPath);
    return normPath.startsWith(normRoot + '/') ? normPath.slice(normRoot.length + 1) : null;
  })();
  const headRelPath = change?.origPath ?? relPath;

  // Only tracked, changed files need a HEAD fetch; every other case is
  // derived at render time below (no state, no effect-set-state cascades).
  const fetchKey =
    repoRoot && headRelPath && rowStatus && rowStatus !== 'untracked' && rowStatus !== 'added'
      ? `${repoRoot}\u0000${headRelPath}\u0000${rowStatus}\u0000${statusRevision}`
      : null;

  const [fetched, setFetched] = useState<{ key: string; content: string | null } | null>(null);

  useEffect(() => {
    if (!fetchKey || !repoRoot || !headRelPath) return undefined;
    let stale = false;
    GitFileAtRev(repoRoot, 'HEAD', headRelPath)
      .then((fc) => {
        if (stale) return;
        setFetched({ key: fetchKey, content: fc.binary || fc.truncated ? null : fc.content });
      })
      .catch(() => {
        if (!stale) setFetched({ key: fetchKey, content: null });
      });
    return () => {
      stale = true;
    };
  }, [fetchKey, repoRoot, headRelPath]);

  if (!absPath || !repoRoot || !rowStatus || !relPath) return null;
  if (rowStatus === 'untracked' || rowStatus === 'added') return '';
  return fetched?.key === fetchKey ? fetched.content : null;
}
