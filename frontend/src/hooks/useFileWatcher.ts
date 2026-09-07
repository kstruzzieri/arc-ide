import { useEffect, useCallback } from 'react';
import { EventsOn } from '../wails/runtime';
import { StartWatching, StopWatching } from '../wails/bindings';
import type { FileEvent } from '../types/watcher';

/**
 * Handler function for file change events.
 */
export type FileChangeHandler = (event: FileEvent) => void;

/**
 * Hook to watch for file system changes in a directory.
 *
 * @param path - The directory path to watch. Pass null/undefined to disable watching.
 * @param onFileChange - Callback function invoked when a file change event occurs.
 *
 * @example
 * ```tsx
 * useFileWatcher('/path/to/workspace', (event) => {
 *   console.log(`File ${event.type}: ${event.path}`);
 *   if (event.type === 'modified') {
 *     // Refresh file content if open in editor
 *   }
 * });
 * ```
 */
export function useFileWatcher(
  path: string | null | undefined,
  onFileChange: FileChangeHandler
): void {
  // Memoize the handler to prevent unnecessary re-subscriptions
  const handleFileChange = useCallback(
    (event: FileEvent) => {
      onFileChange(event);
    },
    [onFileChange]
  );

  useEffect(() => {
    if (!path) {
      return;
    }

    // Subscribe to file change events from the backend
    const cleanup = EventsOn('file:changed', handleFileChange);

    // Start watching the directory
    StartWatching(path).catch((err: unknown) => {
      console.error('Failed to start file watching:', err);
    });

    // Cleanup: unsubscribe from events and stop watching
    return () => {
      cleanup();
      StopWatching().catch((err: unknown) => {
        console.error('Failed to stop file watching:', err);
      });
    };
  }, [path, handleFileChange]);
}
