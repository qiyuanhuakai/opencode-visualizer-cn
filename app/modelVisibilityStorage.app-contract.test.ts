import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('App model visibility storage contract', () => {
  it('routes current and legacy model visibility state through shared storage', () => {
    // Given: Electron persistence owns every opencode-prefixed renderer setting.
    const appSource = readFileSync(resolve(__dirname, 'App.vue'), 'utf8');
    const storageSource = readFileSync(
      resolve(__dirname, 'utils/modelVisibilityStorage.ts'),
      'utf8',
    );

    // When: App reads, writes, and removes model visibility state.
    const storageCalls = [
      /storageGet\(\s*StorageKeys\.settings\.modelVisibility\s*\)/u,
      /storageGet\(\s*StorageKeys\.settings\.disabledModels\s*\)/u,
      /storageSet\(\s*StorageKeys\.settings\.modelVisibility\s*,/u,
      /storageRemove\(\s*StorageKeys\.settings\.disabledModels\s*\)/u,
    ];

    // Then: model visibility delegates semantics to the canonical shared-storage utility.
    expect(appSource).toMatch(/from ['"]\.\/utils\/modelVisibilityStorage['"]/u);
    storageCalls.forEach((call) => expect(storageSource).toMatch(call));
    expect(appSource).not.toContain('window.localStorage.getItem(MODEL_VISIBILITY_STORAGE_KEY)');
    expect(appSource).not.toContain(
      'window.localStorage.setItem(\n    MODEL_VISIBILITY_STORAGE_KEY',
    );
    expect(appSource).not.toContain(
      'window.localStorage.removeItem(LEGACY_DISABLED_MODELS_STORAGE_KEY)',
    );
    expect(storageSource).not.toContain('window.localStorage');
  });
});
