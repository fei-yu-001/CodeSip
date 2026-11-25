import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: 'web',
  plugins: [react()],
  // Markdown and math run in a Worker. Resolve the official DOM-free exports;
  // the browser variants of these helpers require document.createElement.
  resolve: {
    alias: {
      'hast-util-from-html-isomorphic': fileURLToPath(
        import.meta.resolve('hast-util-from-html-isomorphic'),
      ),
      'decode-named-character-reference': fileURLToPath(
        import.meta.resolve('decode-named-character-reference'),
      ),
    },
  },
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 650 },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4318' } },
});
