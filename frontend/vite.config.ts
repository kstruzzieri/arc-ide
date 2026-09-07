import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wails from '@wailsio/runtime/plugins/vite';

// The dev-server port lives in the root Taskfile.yml (VITE_PORT), which passes
// it to both wails3 and `npm run dev -- --port ... --strictPort`. Repeating a
// default here would make this the second place to edit and let the two drift,
// so an unset WAILS_VITE_PORT falls back to Vite's own default and drops the
// strictPort demand along with it. A *set* value that isn't a positive integer
// is a misconfiguration, not a cue to fall back silently, so it throws instead.
const rawPort = process.env.WAILS_VITE_PORT;
const devPort = ((): number | undefined => {
  if (rawPort === undefined) return undefined;
  const parsed = Number(rawPort);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`WAILS_VITE_PORT must be a positive integer, got "${rawPort}"`);
  }
  return parsed;
})();

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), wails('./bindings')],
  server: {
    host: '127.0.0.1',
    port: devPort,
    strictPort: devPort !== undefined,
    hmr: {
      overlay: false,
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Split CodeMirror into its own chunk
          codemirror: [
            '@codemirror/state',
            '@codemirror/view',
            '@codemirror/commands',
            '@codemirror/language',
            '@codemirror/autocomplete',
            '@codemirror/lint',
            '@codemirror/search',
          ],
          // React vendor chunk
          react: ['react', 'react-dom', 'react-dom/client'],
          // Terminal emulator
          xterm: ['@xterm/xterm', '@xterm/addon-fit'],
          // State management
          zustand: ['zustand'],
        },
      },
    },
    // Increase warning limit for production build
    chunkSizeWarningLimit: 600,
  },
});
