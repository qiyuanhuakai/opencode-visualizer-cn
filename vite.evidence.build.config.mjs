import path from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  root: 'app',
  plugins: [vue()],
  resolve: {
    alias: {
      buffer: 'buffer/',
      fs: path.resolve(import.meta.dirname, 'app/utils/node-polyfill.ts'),
      path: path.resolve(import.meta.dirname, 'app/utils/node-polyfill.ts'),
      crypto: path.resolve(import.meta.dirname, 'app/utils/node-polyfill.ts'),
    },
  },
  worker: { format: 'es' },
  define: { __GIT_REVISION__: JSON.stringify('evidence') },
  build: {
    outDir: '../dist-evidence',
    emptyOutDir: true,
    rollupOptions: {
      input: { task23: path.resolve(import.meta.dirname, 'app/dev/task23-evidence.html') },
    },
  },
});
