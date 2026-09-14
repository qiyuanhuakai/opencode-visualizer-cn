import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfigFromFile } from 'vite';
import type { Alias, AliasOptions } from 'vite';

const repoRoot = path.resolve(__dirname, '..');
const loaded = await loadConfigFromFile(
  { command: 'build', mode: 'test' },
  path.join(repoRoot, 'vite.config.ts'),
  repoRoot,
);

if (loaded === null) throw new Error('vite.config.ts did not export a configuration');

const config = loaded.config;
const aliases = config.resolve?.alias;
const output = Array.isArray(config.build?.rollupOptions?.output)
  ? config.build.rollupOptions.output[0]
  : config.build?.rollupOptions?.output;
const manualChunks = output?.manualChunks;
const chunkApi = { getModuleInfo: () => null, getModuleIds: function* () {} };

function isAliasArray(value: AliasOptions | undefined): value is readonly Alias[] {
  return Array.isArray(value);
}

function aliasValue(name: string): string | undefined {
  if (aliases === undefined) return undefined;
  if (isAliasArray(aliases)) {
    const alias = aliases.find(({ find }) => find === name);
    return typeof alias?.replacement === 'string' ? alias.replacement : undefined;
  }
  const value = aliases[name];
  return typeof value === 'string' ? value : undefined;
}

describe('vite config contract', () => {
  it('keeps a relative base for app:// and GitHub Pages assets', () => {
    expect(config.base).toBe('./');
  });

  it.each([
    ['/repo/node_modules/vue-i18n/dist/index.mjs', 'vendor-vue-i18n'],
    ['/repo/node_modules/vue/dist/vue.runtime.esm.js', 'vendor-vue'],
    ['/repo/node_modules/@headlessui/utils/dist/index.mjs', 'vendor-ui'],
    ['/repo/node_modules/@iconify/utils/dist/index.mjs', 'vendor-ui'],
    ['/repo/node_modules/@xterm/xterm/lib/xterm.js', 'vendor-terminal'],
    ['/repo/node_modules/marked/lib/marked.esm.js', 'vendor-utils'],
    ['/repo/node_modules/date-fns/index.js', 'vendor-utils'],
    ['/repo/node_modules/lodash/lodash.js', 'vendor-utils'],
  ])('classifies %s as %s', (id, expectedChunk) => {
    expect(manualChunks).toBeTypeOf('function');
    if (typeof manualChunks === 'function') expect(manualChunks(id, chunkApi)).toBe(expectedChunk);
  });

  it('leaves application and unrelated dependency modules unclassified', () => {
    expect(manualChunks).toBeTypeOf('function');
    if (typeof manualChunks === 'function') {
      expect(manualChunks('/repo/app/main.ts', chunkApi)).toBeUndefined();
      expect(manualChunks('/repo/node_modules/nanoid/index.js', chunkApi)).toBeUndefined();
    }
  });

  it('keeps the ES worker format', () => {
    expect(config.worker?.format).toBe('es');
  });

  it('keeps the node polyfill aliases', () => {
    expect(aliasValue('buffer')).toBe('buffer/');
    const polyfillPath = path.join(repoRoot, 'app/utils/node-polyfill.ts');
    expect(aliasValue('fs')).toBe(polyfillPath);
    expect(aliasValue('path')).toBe(polyfillPath);
    expect(aliasValue('crypto')).toBe(polyfillPath);
  });

  it('keeps the fixed dev server host and port', () => {
    expect(config.server).toMatchObject({ host: '127.0.0.1', port: 5173, strictPort: true });
  });

  it('defines the git revision as a JSON string literal', () => {
    expect(config.define?.__GIT_REVISION__).toMatch(/^"[0-9a-f]+"$/);
  });

  it('keeps the Vitest environment and discovery contract', () => {
    expect(config.test).toMatchObject({
      environment: 'happy-dom',
      globals: false,
      include: ['**/*.test.ts'],
    });
  });

  it('loads the Vue plugin', () => {
    expect(config.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'vite:vue' })]),
    );
  });
});
