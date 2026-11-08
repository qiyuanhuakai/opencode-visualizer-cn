import { StorageKeys } from '../../utils/storageKeys';
import { isLocalCredential } from '../../../shared/runtime/migration/legacyExport.js';

export const legacyKeyInventory = [
  ...Object.entries(StorageKeys).flatMap(([category, group]) => Object.values(group).map(value => ({
    key: `opencode.${value}`, category, registry: true, localOnly: isLocalCredential(`opencode.${value}`),
  }))),
  ...['opencode.global.dat:model', 'opencode.settings.disabledModels.v1', 'vis:kimi-web:last-permission-mode', 'vis.codex.pins.v1', 'opencode.credentials.v1'].map(key => ({ key, category: 'legacy', registry: false, localOnly: isLocalCredential(key) })),
];
export const legacyDynamicInventory = [
  'opencode.state.codexAuxiliaryHistory.v1.<thread>', 'opencode.state.codexTurnEfforts.v1.<thread>',
  'opencode.state.codexMessageModels.v1.<endpoint>.<thread>', 'opencode.state.backendHistory.v1.<scope32hex>.<session>',
  'opencode.kimiWebSessionModes.<encoded-scope-session>', 'opencode.state.dshLastSelection.v1:<encoded-endpoint>',
] as const;
export const legacySourceInventory = [
  { source: 'localStorage', stores: ['current-origin'] },
  { source: 'indexedDB', database: 'opencode.codexAuxiliaryHistory', stores: ['snapshots'] },
  { source: 'indexedDB', database: 'opencode.backendHistory', stores: ['histories'], indexes: ['session'] },
  { source: 'sessions.sqlite', stores: ['meta', 'kv', 'threads', 'messages', 'parts'] },
  { source: 'renderer-settings.json', stores: ['string-map'] },
  { source: 'renderer-storage.json', stores: ['string-map'] },
  { source: 'renderer-storage.json.history', stores: ['sha256-shards'] },
] as const;

export function isLegacyKey(key: string): boolean {
  return key.startsWith('opencode.') || key === 'vis:kimi-web:last-permission-mode' || key === 'vis.codex.pins.v1';
}
