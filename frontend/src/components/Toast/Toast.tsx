import { useEffect } from 'react';
import { useToast, useIDEStore } from '../../stores/ideStore';
import styles from './Toast.module.css';

const TOAST_DURATION = 4000;

export function Toast() {
  const toast = useToast();
  const clearToast = useIDEStore((state) => state.clearToast);

  useEffect(() => {
    if (!toast || toast.sticky) return;
    const timer = setTimeout(clearToast, TOAST_DURATION);
    return () => clearTimeout(timer);
  }, [toast, clearToast]);

  if (!toast) return null;

  return (
    <div className={`${styles.toast} ${styles[toast.type]}`} role="alert" aria-live="assertive">
      <span className={styles.message}>{toast.message}</span>
      <button className={styles.close} onClick={clearToast} aria-label="Dismiss" type="button">
        ×
      </button>
    </div>
  );
}
