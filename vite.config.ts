import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/vis',
  root: 'app',
  plugins: [
    vue(),
  ],
  worker: {
    format: 'es',
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
