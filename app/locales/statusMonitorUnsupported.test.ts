import { describe, expect, it } from 'vitest';

import en from './en';
import eo from './eo';
import ja from './ja';
import zhCN from './zh-CN';
import zhTW from './zh-TW';

const locales = [en, zhCN, zhTW, ja, eo];
const sections = ['mcp', 'lsp', 'skills', 'plugins'] as const;

describe('statusMonitor unsupported message locale completeness', () => {
  it.each(locales)(
    'defines ACP-worded unsupported messages without OpenCode wording',
    (messages) => {
      for (const section of sections) {
        const value = Reflect.get(messages.statusMonitor[section], 'unsupportedAcp');
        expect(value).toEqual(expect.any(String));
        expect(String(value)).not.toContain('OpenCode');
      }
    },
  );

  it.each(locales)('keeps lsp.unsupported backend-generic', (messages) => {
    const value = Reflect.get(messages.statusMonitor.lsp, 'unsupported');
    expect(value).toEqual(expect.any(String));
    expect(String(value)).not.toContain('ACP');
  });
});
