export const KIMI_PLUGIN_OPERATIONS = Object.freeze({
  'kimi.plugins.list': { method: 'GET', path: '/api/v1/plugins' },
  'kimi.plugins.marketplace': { method: 'GET', path: '/api/v1/plugins/marketplace' },
  'kimi.plugins.install': { method: 'POST', path: '/api/v1/plugins' },
  'kimi.plugins.action': { method: 'POST', path: '/api/v1/plugins/{tail}' },
});
