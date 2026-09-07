import { useEffect, useState } from 'react';
import type { LSPServerStatus } from '../../stores/lspStore';
import { useIDEStore } from '../../stores/ideStore';
import { describeSetup } from './lspSetupNotice';
import {
  LSPRetryProvision,
  LSPSetInterpreter,
  LSPClearInterpreter,
  LSPDoctor,
} from '../../wails/bindings';
import styles from './LSPSetupCard.module.css';

function showActionError(action: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  useIDEStore.getState().showToast(`Failed to ${action}: ${message}`, 'error');
}

export function LSPSetupCard({
  status,
  workspacePath,
}: {
  status: LSPServerStatus | undefined;
  workspacePath: string;
}) {
  const notice = describeSetup(status);
  const [candidates, setCandidates] = useState<string[]>([]);
  const action = status?.action;
  const wantsPicker = action === 'select_interpreter' || action === 'create_venv';

  useEffect(() => {
    let cancelled = false;
    if (wantsPicker && workspacePath) {
      LSPDoctor(workspacePath)
        .then((r) => {
          if (!cancelled) setCandidates(r?.candidates ?? []);
        })
        .catch(() => {
          if (!cancelled) setCandidates([]);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [wantsPicker, workspacePath]);

  if (!notice) return null;

  const showActions = action === 'retry' || wantsPicker || status?.configSource === 'override';

  return (
    <div role="status" aria-live="polite" className={`${styles.card} ${styles[notice.tone]}`}>
      <span className={styles.message}>{notice.message}</span>
      <span className={styles.hint}>{notice.hint}</span>
      {showActions && (
        <div className={styles.actions}>
          {action === 'retry' && status && (
            <button
              type="button"
              onClick={() =>
                LSPRetryProvision(status.family, status.projectRoot ?? workspacePath).catch(
                  (error) => showActionError('retry LSP provisioning', error)
                )
              }
            >
              Retry
            </button>
          )}
          {wantsPicker && (
            <select
              aria-label="Select interpreter"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) LSPSetInterpreter(workspacePath, e.target.value);
              }}
            >
              <option value="" disabled>
                Select interpreter...
              </option>
              {candidates.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
          {status?.configSource === 'override' && (
            <button
              type="button"
              onClick={() =>
                LSPClearInterpreter(workspacePath).catch((error) =>
                  showActionError('reset the Python interpreter', error)
                )
              }
            >
              Reset to auto
            </button>
          )}
        </div>
      )}
    </div>
  );
}
