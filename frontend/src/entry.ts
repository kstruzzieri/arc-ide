// Every module below the branch styles itself from these, so they are loaded
// here rather than inside either root: this file is the one thing both roots
// pass through, and a satellite that only imported them via `App` would render
// with every custom property undefined.
import './styles/tokens.css';
import './styles/reset.css';
import { createElement, StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Which root this page mounts: the IDE, or the undocked Golem window (#271).
 *
 * Both windows load the same Vite bundle; only the URL differs. Go opens the
 * satellite at `/#/golem-window` (`golemWindowURL` in app_golem_window.go), and
 * everything else is the IDE.
 *
 * The branch is taken with DYNAMIC imports on purpose. A static
 * `import App from './App'` runs at module evaluation, which would instantiate
 * the IDE's executing stores, the Golem bridge and workspace persistence inside
 * the satellite window even though nothing ever renders them — a second owner
 * of the same conversation, created by an import statement.
 */

export type FirnRoot = 'ide' | 'golem-window';

export function selectRoot(hash: string): FirnRoot {
  return hash === '#/golem-window' ? 'golem-window' : 'ide';
}

/** Resolves once the chosen root has been mounted into `#root`. */
export async function mountFirn(): Promise<void> {
  const container = document.getElementById('root');
  if (!container) {
    throw new Error('Root element #root not found in document');
  }
  const Root: ComponentType =
    selectRoot(window.location.hash) === 'golem-window'
      ? (await import('./components/GolemWindow/GolemWindowRoot')).GolemWindowRoot
      : (await import('./App')).default;

  createRoot(container).render(createElement(StrictMode, null, createElement(Root)));
}
