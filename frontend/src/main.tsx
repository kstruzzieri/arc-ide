import { mountFirn } from './entry';

// The root is chosen from the URL before either owner graph is imported, so the
// undocked Golem window never evaluates the IDE's stores (#271 Task B5).
void mountFirn().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const container = document.getElementById('root');
  // A blank window explains nothing; whatever went wrong is said out loud.
  if (container) container.textContent = `Firn could not start: ${message}`;
  console.error('Firn could not start:', error);
});
