import { describe, expect, it } from 'vitest';

import { acpLocales, expectNonEmptyString } from './test-helpers';

const dshLoginKeys = [
  'dshTitle',
  'dshBackend',
  'dshBridgeUrl',
  'dshBridgeToken',
  'dshBridgeHint',
  'dshErrors',
] as const;

const dshErrorKeys = [
  'bridgeUrlRequired',
  'missingCredential',
  'nativeServicesDisabled',
  'launchTokenMissing',
  'versionMismatch',
] as const;

// Prose keys are the ones an English fallback would leak through: a product
// name ("DSH") or a ws:// placeholder is legitimately identical in every
// locale, so only these are asserted to be translated.
const dshProseKeys = ['dshTitle', 'dshBridgeHint'] as const;

function collectDshErrorKeys(messages: (typeof acpLocales)[number][1]): string[] {
  const errors = messages.app.login.dshErrors;
  expect(errors).toBeTruthy();
  return Object.keys(errors).sort();
}

describe('DSH login locale completeness', () => {
  it.each(acpLocales)('%s exposes every DSH login key', (_locale, messages) => {
    expectNonEmptyString(messages.app.login.dshTitle);
    expectNonEmptyString(messages.app.login.dshBackend);
    expectNonEmptyString(messages.app.login.dshBridgeUrl);
    expectNonEmptyString(messages.app.login.dshBridgeToken);
    expectNonEmptyString(messages.app.login.dshBridgeHint);
    expect(messages.app.login.dshErrors).toBeTruthy();
  });

  it.each(acpLocales)('%s exposes every DSH connection error copy', (_locale, messages) => {
    for (const key of dshErrorKeys) {
      expectNonEmptyString(
        messages.app.login.dshErrors?.[key as keyof typeof messages.app.login.dshErrors],
      );
    }
  });

  it('keeps the DSH login key set identical across locales', () => {
    const expectedKeys = [...dshLoginKeys].sort();
    for (const [_locale, messages] of acpLocales) {
      expect(
        Object.keys(messages.app.login)
          .filter((key) => key.startsWith('dsh'))
          .sort(),
      ).toEqual(expectedKeys);
    }
  });

  it('keeps the DSH error key set identical across locales', () => {
    const expectedKeys = [...dshErrorKeys].sort();
    for (const [_locale, messages] of acpLocales) {
      expect(collectDshErrorKeys(messages)).toEqual(expectedKeys);
    }
  });

  it('translates the DSH prose keys instead of falling back to English', () => {
    const english = acpLocales.find(([locale]) => locale === 'en');
    if (!english) throw new Error('English locale is missing from the locale table');
    const [, enMessages] = english;
    for (const [locale, messages] of acpLocales) {
      if (locale === 'en') continue;
      for (const key of dshProseKeys) {
        expect(messages.app.login[key], `${locale} app.login.${key}`).not.toBe(
          enMessages.app.login[key],
        );
      }
    }
  });
});
