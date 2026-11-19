import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserLegacySource } from '../runtime/migration/legacyBrowserSource';
import { openLegacyExport, readLegacyExportPage } from '../runtime/migration/legacyExport';
import { storageSet, storageRemove } from './storageKeys';
import { liveSettingKey } from '../../shared/runtime/liveSettings.js';

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

it('preserves a browser legacy export token while live settings and local credential tombstones change', async () => {
  const factory: IDBFactory = {
    databases: async () => [],
    cmp() { throw new Error('No legacy database present'); },
    open() { throw new Error('No legacy database should be opened'); },
    deleteDatabase() { throw new Error('Legacy source is read only'); },
  };
  const oldKey = 'opencode.vis.runtime.bridgeUrl';
  localStorage.setItem(oldKey, 'ws://legacy.invalid/runtime');
  localStorage.setItem('opencode.drafts.composer.v1', 'original-private-body');
  const source = createBrowserLegacySource({ storage: localStorage, indexedDB: factory, origin: location.origin });
  const token = await openLegacyExport(source);
  const before = await readLegacyExportPage(source, { token });
  expect(storageSet('vis.runtime.bridgeUrl', 'ws://127.0.0.1:35807/runtime')).toBe(true);
  expect(storageSet('auth.credentials.v1', 'synthetic-local-only-marker')).toBe(true);
  expect(storageRemove('vis.runtime.bridgeUrl')).toBe(true);
  expect(localStorage.getItem(oldKey)).toBe('ws://legacy.invalid/runtime');
  expect(localStorage.getItem(liveSettingKey('vis.runtime.bridgeUrl'))).not.toBeNull();
  const after = await readLegacyExportPage(source, { token });
  expect(after).toEqual(before);
  expect(JSON.stringify({ token, after })).not.toContain('synthetic-local-only-marker');
  expect(JSON.stringify(after)).not.toContain('vis.live-settings.');
});
