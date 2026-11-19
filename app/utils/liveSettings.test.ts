import { expect, it } from 'vitest';
import { StorageKeys } from './storageKeys';
import { LIVE_SETTING_KEYS, liveSettingKey, parseLiveSettingKey, encodeLiveSetting, decodeLiveSetting, normalizeSettingsChange } from '../../shared/runtime/liveSettings.js';

it('defines finite ownership matching registered settings and connection preferences', () => {
  expect([...LIVE_SETTING_KEYS].sort()).toEqual([...Object.values(StorageKeys.settings), ...Object.values(StorageKeys.auth), 'credentials.v1', 'vis.runtime.bridgeUrl', StorageKeys.state.sidePanelCollapsed, StorageKeys.state.sidePanelTab].sort());
  for (const key of LIVE_SETTING_KEYS) expect(parseLiveSettingKey(liveSettingKey(key))).toBe(key);
  for (const key of ['settings.unknown', StorageKeys.drafts.composer, StorageKeys.state.pinnedSessions, StorageKeys.favorites.messages, StorageKeys.state.codexActiveThread]) {
    expect(() => liveSettingKey(key)).toThrow();
    expect(parseLiveSettingKey('vis.live-settings.v1.' + key)).toBeNull();
  }
});

it('roundtrips valid envelopes and rejects malformed records', () => {
  expect(decodeLiveSetting(encodeLiveSetting(''))).toEqual({ kind: 'value', value: '' });
  expect(decodeLiveSetting(encodeLiveSetting('theme'))).toEqual({ kind: 'value', value: 'theme' });
  expect(decodeLiveSetting(encodeLiveSetting(null))).toEqual({ kind: 'missing' });
  for (const raw of ['bad', 'null', '[]', '{}', '{"version":2,"value":"x"}', '{"version":1,"value":42}', '{"version":1,"value":null,"extra":1}']) expect(decodeLiveSetting(raw)).toEqual({ kind: 'error' });
});

it('normalizes live and stale legacy events using the effective value without resurrecting tombstones', () => {
  const key = StorageKeys.settings.themeTokens;
  const read = () => ({ kind: 'missing' as const });
  expect(normalizeSettingsChange({ key: liveSettingKey(key), newValue: encodeLiveSetting(null) }, read)).toEqual({ key: 'opencode.' + key, newValue: null });
  expect(normalizeSettingsChange({ key: 'opencode.' + key, newValue: 'stale' }, read)).toEqual({ key: 'opencode.' + key, newValue: null });
  expect(normalizeSettingsChange({ key: liveSettingKey(key), newValue: 'broken' }, () => ({ kind: 'error' }))).toBeNull();
  expect(normalizeSettingsChange({ key: liveSettingKey(key), newValue: 'broken' }, () => ({ kind: 'value', value: 'current' }))).toBeNull();
  expect(normalizeSettingsChange({ key: 'vis.live-settings.v1.unknown', newValue: 'x' }, read)).toBeNull();
  const approved = StorageKeys.settings.localApplicationPath;
  expect(normalizeSettingsChange({ key: 'opencode.' + approved, newValue: '/approved' }, () => ({ kind: 'value', value: '/approved' }))).toEqual({ key: 'opencode.' + approved, newValue: '/approved' });
});
