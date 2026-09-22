import { describe, expect, it } from 'vitest';

import { acpLocales, expectNonEmptyString } from './test-helpers';

const kimiWebLoginKeys = [
  'kimiWebTitle',
  'kimiWebBackend',
  'kimiWebBridgeUrl',
  'kimiWebBridgeToken',
  'kimiWebBridgeHint',
] as const;

// Prose keys are the ones an English fallback would leak through: a product
// name ("Kimi Web") or a ws:// placeholder is legitimately identical in every
// locale, so only these are asserted to be translated.
const kimiWebProseKeys = ['kimiWebTitle', 'kimiWebBridgeHint'] as const;

describe('Kimi Web login locale completeness', () => {
  it.each(acpLocales)('%s exposes every Kimi Web login key', (_locale, messages) => {
    expectNonEmptyString(messages.app.login.kimiWebTitle);
    expectNonEmptyString(messages.app.login.kimiWebBackend);
    expectNonEmptyString(messages.app.login.kimiWebBridgeUrl);
    expectNonEmptyString(messages.app.login.kimiWebBridgeToken);
    expectNonEmptyString(messages.app.login.kimiWebBridgeHint);
  });

  it('keeps the Kimi Web login key set identical across locales', () => {
    const expectedKeys = [...kimiWebLoginKeys].sort();
    for (const [_locale, messages] of acpLocales) {
      expect(
        Object.keys(messages.app.login)
          .filter((key) => key.startsWith('kimiWeb'))
          .sort(),
      ).toEqual(expectedKeys);
    }
  });

  it('translates the Kimi Web prose keys instead of falling back to English', () => {
    const english = acpLocales.find(([locale]) => locale === 'en');
    if (!english) throw new Error('English locale is missing from the locale table');
    const [, enMessages] = english;
    for (const [locale, messages] of acpLocales) {
      if (locale === 'en') continue;
      for (const key of kimiWebProseKeys) {
        expect(messages.app.login[key], `${locale} app.login.${key}`).not.toBe(
          enMessages.app.login[key],
        );
      }
    }
  });
});
