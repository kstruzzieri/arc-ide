import React, { Component, ErrorInfo, ReactNode } from 'react';
import styles from './ErrorBoundary.module.css';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('Firn IDE Error:', error);
    console.error('Component stack:', errorInfo.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            backgroundColor: 'var(--surface-base)',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-ui)',
            padding: '20px',
            textAlign: 'center',
          }}
        >
          <h1 style={{ fontSize: '24px', marginBottom: '16px', color: 'var(--status-error)' }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '24px' }}>
            {this.state.error?.message ?? 'An unexpected error occurred'}
          </p>
          <ReloadButton />
        </div>
      );
    }

    return this.props.children;
  }
}

// Internal component, not exported - disable fast refresh warning
// eslint-disable-next-line react-refresh/only-export-components
function ReloadButton() {
  return (
    <button type="button" className={styles.reload} onClick={() => window.location.reload()}>
      Reload Application
    </button>
  );
}
