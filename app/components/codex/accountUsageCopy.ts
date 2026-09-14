export const accountUsageCopy = {
  en: {
    title: 'Codex account token activity', today: 'Today (UTC)', week: 'Last 7 days (UTC)', lifetime: 'Lifetime tokens',
    daily: 'Daily tokens', date: 'Date (UTC)', tokens: 'Tokens', empty: 'No account activity is available.',
    disconnected: 'Connect Codex to load account token activity.', unsupported: 'Account token activity is unavailable for this server or authentication method.',
    failed: 'Could not load account token activity.', refresh: 'Refresh account activity', loading: 'Loading account activity…',
    hint: 'Account-wide activity, separate from this session and Codex quota limits.',
  },
  zh: {
    title: 'Codex 账户 Token 活动', today: '今日（UTC）', week: '近 7 日（UTC）', lifetime: '累计 Token',
    daily: '每日 Token', date: '日期（UTC）', tokens: 'Token', empty: '暂无账户活动数据。',
    disconnected: '连接 Codex 后可查看账户 Token 活动。', unsupported: '当前服务器或认证方式不支持账户 Token 活动。',
    failed: '无法加载账户 Token 活动。', refresh: '刷新账户活动', loading: '正在加载账户活动…',
    hint: '账户级活动，与当前会话消耗及 Codex 额度分开统计。',
  },
} as const;
