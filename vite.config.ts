import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: 'web',
  plugins: [react()],
  // The browser export uses document.createElement, which does not exist in a
  // Worker. Resolve the package's official DOM-free decoder in both builds.
  resolve: {
    alias: {
      'decode-named-character-reference': fileURLToPath(
        import.meta.resolve('decode-named-character-reference'),
      ),
    },
  },
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 650 },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4318' } },
});
