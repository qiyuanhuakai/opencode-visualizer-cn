import { describe, expect, it } from 'vitest';

import en from './en';
import { acpLocales, expectNonEmptyString } from './test-helpers';

const providerNoteKeys = Object.keys(en.providerManager.providerNotes).sort();

describe('ACP provider note locale completeness', () => {
  it.each(acpLocales)('%s defines an ACP provider note', (_locale, messages) => {
    expectNonEmptyString(Reflect.get(messages.providerManager.providerNotes, 'acp'));
  });

  it('keeps provider note keys identical across locales', () => {
    for (const [_locale, messages] of acpLocales) {
      expect(Object.keys(messages.providerManager.providerNotes).sort()).toEqual(providerNoteKeys);
    }
  });
});
