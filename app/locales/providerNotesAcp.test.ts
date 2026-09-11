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

const providerNoteKeys = Object.keys(en.providerManager.providerNotes).sort();

function expectNonEmptyString(value: unknown) {
  expect(typeof value).toBe('string');
  if (typeof value === 'string') expect(value.trim()).not.toBe('');
}

describe('ACP provider note locale completeness', () => {
  it.each(locales)('%s defines an ACP provider note', (_locale, messages) => {
    expectNonEmptyString(Reflect.get(messages.providerManager.providerNotes, 'acp'));
  });

  it('keeps provider note keys identical across locales', () => {
    for (const [_locale, messages] of locales) {
      expect(Object.keys(messages.providerManager.providerNotes).sort()).toEqual(providerNoteKeys);
    }
  });
});
