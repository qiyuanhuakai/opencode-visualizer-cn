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
const sections = ['mcp', 'lsp', 'skills', 'plugins'] as const;
const unsupportedKeys = sections.flatMap((section) => [
  `${section}.unsupported`,
  `${section}.unsupportedAcp`,
]);

function expectNonEmptyString(value: unknown) {
  expect(typeof value).toBe('string');
  if (typeof value === 'string') expect(value.trim()).not.toBe('');
}

describe('statusMonitor unsupported message locale completeness', () => {
  it.each(locales)(
    '%s defines ACP-worded unsupported messages without OpenCode wording',
    (_locale, messages) => {
      for (const section of sections) {
        const value = Reflect.get(messages.statusMonitor[section], 'unsupportedAcp');
        expectNonEmptyString(value);
        expect(String(value)).not.toContain('OpenCode');
      }
    },
  );

  it.each(locales)('%s keeps lsp.unsupported backend-generic', (_locale, messages) => {
    const value = Reflect.get(messages.statusMonitor.lsp, 'unsupported');
    expectNonEmptyString(value);
    expect(String(value)).not.toContain('ACP');
  });

  it('keeps unsupported message keys identical across locales', () => {
    for (const [_locale, messages] of locales) {
      const keys = sections.flatMap((section) =>
        Object.keys(messages.statusMonitor[section])
          .filter((key) => key === 'unsupported' || key === 'unsupportedAcp')
          .map((key) => `${section}.${key}`),
      );
      expect(keys.sort()).toEqual([...unsupportedKeys].sort());
    }
  });
});
