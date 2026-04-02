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
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Vendor chunk: Vue ecosystem
          if (id.includes('node_modules') && (
            id.includes('vue') || 
            id.includes('vue-i18n')
          )) {
            return 'vendor-vue';
          }
          
          // Vendor chunk: UI components
          if (id.includes('node_modules') && (
            id.includes('@headlessui') ||
            id.includes('@iconify')
          )) {
            return 'vendor-ui';
          }
          
          // Terminal chunk (heavy)
          if (id.includes('node_modules') && id.includes('@xterm')) {
            return 'vendor-terminal';
          }
          
          // Utilities
          if (id.includes('node_modules') && (
            id.includes('marked') ||
            id.includes('date-fns') ||
            id.includes('lodash')
          )) {
            return 'vendor-utils';
          }
        },
      },
    },
  },
});
