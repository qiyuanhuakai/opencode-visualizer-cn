import { describe, expect, it } from 'vitest';

import en from './en';
import eo from './eo';
import ja from './ja';
import zhCN from './zh-CN';
import zhTW from './zh-TW';

describe('Codex rate-limit locale labels', () => {
  it('describes the current weekly limit without the removed five-hour window', () => {
    expect([
      en.statusMonitor.codex.rateLimitUsed,
      zhCN.statusMonitor.codex.rateLimitUsed,
      zhTW.statusMonitor.codex.rateLimitUsed,
      ja.statusMonitor.codex.rateLimitUsed,
      eo.statusMonitor.codex.rateLimitUsed,
    ]).toEqual([
      'Used (weekly)',
      '已用（每周）',
      '已用（每週）',
      '使用済み（週間）',
      'Uzita (semajna)',
    ]);
  });
});
