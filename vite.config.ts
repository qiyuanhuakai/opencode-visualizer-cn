import { execSync } from 'node:child_process';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const gitRevision = execSync('git rev-parse --short HEAD').toString().trim();

export default defineConfig({
  base: './',
  root: 'app',
  plugins: [vue()],
  worker: {
    format: 'es',
  },
  define: {
    __GIT_REVISION__: JSON.stringify(gitRevision),
  },
  build: {
    chunkSizeWarningLimit: 1000,
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;

          if (id.includes('vue-i18n')) {
            return 'vendor-vue-i18n';
          }

          if (id.includes('vue')) {
            return 'vendor-vue';
          }

          if (id.includes('@headlessui') || id.includes('@iconify')) {
            return 'vendor-ui';
          }

          if (id.includes('@xterm')) {
            return 'vendor-terminal';
          }

          if (id.includes('marked') || id.includes('date-fns') || id.includes('lodash')) {
            return 'vendor-utils';
          }
        },
      },
    },
  },
});
