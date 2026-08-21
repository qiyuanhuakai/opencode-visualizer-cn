import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CONFIG_PATH = path.resolve(__dirname, '../vite.config.ts');
const PACKAGE_PATH = path.resolve(__dirname, '../package.json');

// Static contract over vite.config.ts (string-level, mirroring
// electronSmokeContract.test.ts): the Vite 8 migration (Task 7) must keep the
// relative base (app:// and GitHub Pages hosting), the manualChunks vendor
// split, the ES worker format, the node polyfill aliases, the fixed dev server
// host/port, the __GIT_REVISION__ define, the happy-dom test environment, and
// the build/test stack majors (vite 8, vitest 4, happy-dom 20, plugin-vue 6).
const configSource = readFileSync(CONFIG_PATH, 'utf8');

describe('vite config contract', () => {
  it('keeps the relative base (app:// and GitHub Pages must not use /assets)', () => {
    expect(configSource).toMatch(/base:\s*'\.\/'/);
    expect(configSource).not.toMatch(/base:\s*['"]\//);
  });

  it('keeps manualChunks with every vendor group', () => {
    expect(configSource).toMatch(/manualChunks\s*\(/);
    for (const marker of [
      'vendor-vue-i18n',
      'vendor-vue',
      'vendor-ui',
      'vendor-terminal',
      'vendor-utils',
    ]) {
      expect(configSource).toContain(`'${marker}'`);
    }
  });

  it('keeps the ES worker format', () => {
    expect(configSource).toMatch(/format:\s*'es'/);
  });

  it('keeps the node polyfill aliases', () => {
    expect(configSource).toMatch(/buffer:\s*'buffer\/'/);
    for (const name of ['fs', 'path', 'crypto']) {
      expect(configSource).toMatch(
        new RegExp(`${name}:\\s*path\\.resolve\\(__dirname,\\s*'app/utils/node-polyfill\\.ts'\\)`),
      );
    }
  });

  it('keeps the fixed dev server host/port', () => {
    expect(configSource).toMatch(/host:\s*'127\.0\.0\.1'/);
    expect(configSource).toMatch(/port:\s*5173/);
    expect(configSource).toMatch(/strictPort:\s*true/);
  });

  it('keeps the git revision define', () => {
    expect(configSource).toContain('__GIT_REVISION__');
  });

  it('keeps happy-dom as the test environment with the full include glob', () => {
    expect(configSource).toMatch(/environment:\s*'happy-dom'/);
    expect(configSource).toMatch(/include:\s*\[\s*'\*\*\/\*\.test\.ts'\s*\]/);
    expect(configSource).toMatch(/globals:\s*false/);
  });

  it('keeps the vue plugin', () => {
    expect(configSource).toMatch(/import vue from '@vitejs\/plugin-vue'/);
    expect(configSource).toMatch(/plugins:\s*\[vue\(\)\]/);
  });

  it('locks the build/test stack majors (vite 8, vitest 4, happy-dom 20, plugin-vue 6)', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies['vite']).toMatch(/^\^8\./);
    expect(pkg.devDependencies['vitest']).toMatch(/^\^4\./);
    expect(pkg.devDependencies['happy-dom']).toMatch(/^\^20\./);
    expect(pkg.devDependencies['@vitejs/plugin-vue']).toMatch(/^\^6\./);
    expect(pkg.devDependencies['esbuild']).toMatch(/^\^0\./);
    expect(pkg.devDependencies['postcss']).toMatch(/^\^8\./);
  });
});
