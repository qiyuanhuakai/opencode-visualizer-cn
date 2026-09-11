import { describe, expect, it } from 'vitest';

import en from './en';
import eo from './eo';
import ja from './ja';
import zhCN from './zh-CN';
import zhTW from './zh-TW';

const locales = [
  ['en', en],
  ['zh-CN', zhCN],
  ['zh-TW', zhTW],
  ['ja', ja],
  ['eo', eo],
] as const;

const acpLoginKeys = [
  'acpTitle',
  'acpBackend',
  'acpAgentId',
  'acpBridgeHint',
  'acpBridgeUrl',
  'acpBridgeToken',
] as const;

function expectNonEmptyString(value: unknown) {
  expect(typeof value).toBe('string');
  if (typeof value === 'string') expect(value.trim()).not.toBe('');
}

describe('ACP login locale completeness', () => {
  it.each(locales)('%s exposes every ACP login key', (_locale, messages) => {
    expectNonEmptyString(messages.app.login.acpTitle);
    expectNonEmptyString(messages.app.login.acpBackend);
    expectNonEmptyString(messages.app.login.acpAgentId);
    expectNonEmptyString(messages.app.login.acpBridgeHint);
    expectNonEmptyString(messages.app.login.acpBridgeUrl);
    expectNonEmptyString(messages.app.login.acpBridgeToken);
  });

  it('keeps the ACP login key set identical across locales', () => {
    const expectedKeys = [...acpLoginKeys].sort();
    for (const [_locale, messages] of locales) {
      expect(
        Object.keys(messages.app.login)
          .filter((key) => key.startsWith('acp'))
          .sort(),
      ).toEqual(expectedKeys);
    }
  });
});
