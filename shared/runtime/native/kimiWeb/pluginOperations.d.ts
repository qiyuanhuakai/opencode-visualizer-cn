export const KIMI_PLUGIN_OPERATIONS: Readonly<Record<
  'kimi.plugins.list' | 'kimi.plugins.marketplace' | 'kimi.plugins.install' | 'kimi.plugins.action',
  Readonly<{ method: 'GET' | 'POST'; path: string }>
>>;
