import { describe, expect, it } from 'vitest';

import en from './en';
import eo from './eo';
import ja from './ja';
import zhCN from './zh-CN';
import zhTW from './zh-TW';

describe('ACP provider note locale completeness', () => {
  it.each([en, zhCN, zhTW, ja, eo])('defines an ACP provider note', (messages) => {
    expect(Reflect.get(messages.providerManager.providerNotes, 'acp')).toEqual(expect.any(String));
  });
});
