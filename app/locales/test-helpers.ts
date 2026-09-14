import { expect } from 'vitest';

import en from './en';
import eo from './eo';
import ja from './ja';
import zhCN from './zh-CN';
import zhTW from './zh-TW';

export const acpLocales = [
  ['en', en],
  ['zh-CN', zhCN],
  ['zh-TW', zhTW],
  ['ja', ja],
  ['eo', eo],
] as const;

export function expectNonEmptyString(value: unknown) {
  expect(typeof value).toBe('string');
  if (typeof value === 'string') expect(value.trim()).not.toBe('');
}
