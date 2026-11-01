import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ command }) => ({
  server: { host: '127.0.0.1', port: 5200, strictPort: true },
  resolve: {
    // Keep React imports from the app and optimized dependencies on one runtime.
    dedupe: [
      'react',
      'react-dom',
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/language',
      '@codemirror/commands',
      '@lezer/common',
      '@lezer/lr',
      '@lezer/markdown',
      '@lezer/highlight',
    ],
  },
  optimizeDeps: {
    // The Vim package bundles its own copy of @codemirror/commands when prebundled,
    // giving its `u` handler a historyField different from the app's `history()`.
    exclude: ['@replit/codemirror-vim'],
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'storm-content-security-policy',
      transformIndexHtml: () => [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: [
              "default-src 'none'",
              `script-src 'self'${command === 'serve' ? " 'unsafe-inline'" : ''}`,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' blob: data:",
              "font-src 'self' data:",
              "worker-src 'self' blob:",
              `connect-src 'self'${command === 'serve' ? ' http://127.0.0.1:5200 ws://127.0.0.1:5200' : ''}`,
              "object-src 'none'",
              "base-uri 'none'",
              "form-action 'none'",
              "frame-src 'none'",
            ].join('; '),
          },
          injectTo: 'head-prepend',
        },
      ],
    },
  ],
}));
