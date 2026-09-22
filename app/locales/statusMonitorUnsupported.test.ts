import { describe, expect, it } from 'vitest';

import { acpLocales, expectNonEmptyString } from './test-helpers';
const sections = ['mcp', 'lsp', 'skills', 'plugins'] as const;
const unsupportedKeys = sections.flatMap((section) => [
  `${section}.unsupported`,
  `${section}.unsupportedAcp`,
  `${section}.unsupportedKimiWeb`,
]);

describe('statusMonitor unsupported message locale completeness', () => {
  it.each(acpLocales)(
    '%s defines ACP-worded unsupported messages without OpenCode wording',
    (_locale, messages) => {
      for (const section of sections) {
        const value = Reflect.get(messages.statusMonitor[section], 'unsupportedAcp');
        expectNonEmptyString(value);
        expect(String(value)).not.toContain('OpenCode');
      }
    },
  );

  it.each(acpLocales)(
    '%s defines Kimi Web-worded unsupported messages without foreign-backend wording',
    (_locale, messages) => {
      for (const section of sections) {
        const value = Reflect.get(messages.statusMonitor[section], 'unsupportedKimiWeb');
        expectNonEmptyString(value);
        expect(String(value)).not.toContain('OpenCode');
        expect(String(value)).not.toContain('ACP');
      }
    },
  );

  it.each(acpLocales)('%s keeps lsp.unsupported backend-generic', (_locale, messages) => {
    const value = Reflect.get(messages.statusMonitor.lsp, 'unsupported');
    expectNonEmptyString(value);
    expect(String(value)).not.toContain('ACP');
  });

  it('keeps unsupported message keys identical across locales', () => {
    for (const [_locale, messages] of acpLocales) {
      const keys = sections.flatMap((section) =>
        Object.keys(messages.statusMonitor[section])
          .filter((key) => key === 'unsupported' || key === 'unsupportedAcp' || key === 'unsupportedKimiWeb')
          .map((key) => `${section}.${key}`),
      );
      expect(keys.sort()).toEqual([...unsupportedKeys].sort());
    }
  });
});
