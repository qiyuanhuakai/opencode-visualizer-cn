import { describe, expect, it } from 'vitest';

import en from './en';
import eo from './eo';
import ja from './ja';
import zhCN from './zh-CN';
import zhTW from './zh-TW';

describe('ACP login locale completeness', () => {
  it.each([
    ['en', en],
    ['zh-CN', zhCN],
    ['zh-TW', zhTW],
    ['ja', ja],
    ['eo', eo],
  ])('%s exposes every ACP login key', (_locale, messages) => {
    expect(messages.app.login.acpTitle).toEqual(expect.any(String));
    expect(messages.app.login.acpBackend).toEqual(expect.any(String));
    expect(messages.app.login.acpAgentId).toEqual(expect.any(String));
    expect(messages.app.login.acpBridgeHint).toEqual(expect.any(String));
    expect(messages.app.login.acpBridgeUrl).toEqual(expect.any(String));
    expect(messages.app.login.acpBridgeToken).toEqual(expect.any(String));
  });
});
