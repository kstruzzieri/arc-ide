import { ReactNode } from 'react';
import styles from './Panel.module.css';

interface PanelProps {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Panel({ title, actions, children, className = '' }: PanelProps) {
  return (
    <div className={`${styles.panel} ${className}`}>
      {(title || actions) && (
        <header className={styles.header}>
          {title && <span className={styles.title}>{title}</span>}
          {actions && <div className={styles.actions}>{actions}</div>}
        </header>
      )}
      <div className={styles.content}>{children}</div>
    </div>
  );
}

interface PanelActionProps {
  icon: ReactNode;
  title?: string;
  onClick?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export function PanelAction({ icon, title, onClick, disabled, ariaLabel }: PanelActionProps) {
  return (
    <button
      type="button"
      className={styles.action}
      title={title}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel || title}
    >
      {icon}
    </button>
  );
}
