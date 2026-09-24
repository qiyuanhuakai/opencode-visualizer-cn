import { describe, expect, it } from 'vitest';

import en from './en';
import eo from './eo';
import ja from './ja';
import zhCN from './zh-CN';
import zhTW from './zh-TW';

describe('Codex rate-limit locale labels', () => {
  it('labels the weekly limit', () => {
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
  it('labels the Plus-only five-hour limit separately', () => {
    expect([
      en.statusMonitor.codex.rateLimitFiveHourUsed,
      zhCN.statusMonitor.codex.rateLimitFiveHourUsed,
      zhTW.statusMonitor.codex.rateLimitFiveHourUsed,
      ja.statusMonitor.codex.rateLimitFiveHourUsed,
      eo.statusMonitor.codex.rateLimitFiveHourUsed,
    ]).toEqual([
      'Used (5 hours)',
      '已用（5 小时）',
      '已用（5 小時）',
      '使用済み（5時間）',
      'Uzita (5 horoj)',
    ]);
  });
});
