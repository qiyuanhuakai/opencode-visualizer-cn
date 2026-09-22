import { describe, expect, it } from 'vitest';

import { acpLocales } from './test-helpers';

const composerKeys = [
  'manual',
  'auto',
  'yolo',
  'manualDescription',
  'autoDescription',
  'yoloDescription',
  'plan',
  'swarm',
  'tower',
  'planDescription',
  'swarmDescription',
  'towerDescription',
  'towerDisabled',
  'unknown',
  'unconfirmed',
  'stale',
  'saving',
  'saveFailed',
  'saveUncertain',
  'retry',
  'modeChangePending',
  'modeChangeFailedBeforeSend',
] as const;

const providerKeys = [
  'title',
  'installed',
  'catalog',
  'models',
  'add',
  'edit',
  'save',
  'cancel',
  'delete',
  'deleteConfirm',
  'refresh',
  'refreshing',
  'importCatalog',
  'importConfirm',
  'id',
  'type',
  'baseUrl',
  'status',
  'defaultModel',
  'setDefault',
  'defaultUpdated',
  'apiKey',
  'keyConfigured',
  'keyMissing',
  'keepKey',
  'replaceKey',
  'removeKey',
  'removeKeyConfirm',
  'keyMemoryOnly',
  'keyReentryRequired',
  'environmentKey',
  'environmentKeyHint',
  'addModel',
  'removeModel',
  'modelId',
  'modelName',
  'contextSize',
  'capabilities',
  'managed',
  'managedReadOnly',
  'loading',
  'empty',
  'catalogEmpty',
  'saving',
  'saved',
  'loadFailed',
  'saveFailed',
  'deleteFailed',
  'refreshFailed',
  'importFailed',
  'savedRefreshFailed',
  'invalidId',
  'duplicateId',
  'invalidUrl',
  'invalidModel',
  'dependentModels',
  'replaceDefaultBeforeDelete',
  'unsavedChanges',
] as const;

const existingInputPanelCopy = {
  en: ['Agent selection is not supported by this backend.', 'Loading agents...'],
  'zh-CN': ['当前后端不支持选择代理。', '加载代理中...'],
  'zh-TW': ['目前後端不支援選擇代理。', '載入代理中...'],
  ja: ['このバックエンドはエージェントの選択に対応していません。', 'エージェントを読み込み中…'],
  eo: ['Ĉi tiu backend ne subtenas la elektadon de agento.', 'Ŝargas agentojn…'],
} as const;

function missingOrEmptyKeys(section: unknown, keys: readonly string[]) {
  if (typeof section !== 'object' || section === null) return [...keys];
  return keys.filter((key) => {
    const value = Reflect.get(section, key);
    return typeof value !== 'string' || value.trim() === '';
  });
}

describe('Kimi Web management locale contract', () => {
  it.each(acpLocales)('%s defines every composer key', (_locale, messages) => {
    const kimiWeb = Reflect.get(messages, 'kimiWeb');
    const composer =
      typeof kimiWeb === 'object' && kimiWeb !== null ? Reflect.get(kimiWeb, 'composer') : undefined;

    expect(missingOrEmptyKeys(composer, composerKeys)).toEqual([]);
  });

  it.each(acpLocales)('%s defines every provider key', (_locale, messages) => {
    const kimiWeb = Reflect.get(messages, 'kimiWeb');
    const providers =
      typeof kimiWeb === 'object' && kimiWeb !== null ? Reflect.get(kimiWeb, 'providers') : undefined;

    expect(missingOrEmptyKeys(providers, providerKeys)).toEqual([]);
  });

  it.each(acpLocales)('%s preserves existing agent picker copy', (locale, messages) => {
    expect([messages.inputPanel.agentUnsupported, messages.inputPanel.loadingAgents]).toEqual(
      existingInputPanelCopy[locale],
    );
  });
});
