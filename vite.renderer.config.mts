import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  resolve: {
    // Keep React imports from the app and optimized dependencies on one runtime.
    dedupe: [
      'react',
      'react-dom',
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/language',
      '@codemirror/commands',
      '@lezer/highlight',
    ],
  },
  optimizeDeps: {
    // The Vim package bundles its own copy of @codemirror/commands when prebundled,
    // giving its `u` handler a historyField different from the app's `history()`.
    exclude: ['@replit/codemirror-vim'],
  },
  plugins: [react(), tailwindcss()],
});
