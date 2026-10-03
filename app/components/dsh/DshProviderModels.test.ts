// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { createApp, h, nextTick, shallowRef } from 'vue';
import { createI18n } from 'vue-i18n';
import DshProviderModels from './DshProviderModels.vue';
import type { DshProviderConfiguration } from '../../backends/dsh/dshProviderConfig';
import type { DshJsonValue } from '../../backends/dsh/types';
vi.mock('@iconify/vue', () => ({ Icon: { render: () => null } }));
it('switches model reasoning between custom, disabled and inherited without changing identity', async () => {
  const models = shallowRef<DshJsonValue[] | undefined>([{ id: 'probe', reasoningEfforts: { high: 'high', max: 'ultra' } }]);
  const provider: DshProviderConfiguration = { provider: 'test', displayName: 'Test', settingsNs: 'test', settingsPath: [], revision: 1, writable: true, declared: true, fields: [{ name: 'models', kind: 'models', choices: [], value: models.value, modelReasoningEfforts: true }] };
  const container = document.createElement('div'); document.body.append(container);
  const app = createApp({ render: () => h(DshProviderModels, { modelValue: models.value, provider, rpc: { call: vi.fn(), callMultipart: vi.fn(), nextRpcId: vi.fn() }, draft: {}, disabled: false, 'onUpdate:modelValue': (value: DshJsonValue[] | undefined) => { models.value = value; } }) });
  app.use(createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: { en: {} } }));
  app.mount(container);
  try {
    for (const [mode, expected] of [['disabled', [{ id: 'probe', reasoningEfforts: false }]], ['inherit', [{ id: 'probe' }]], ['custom', [{ id: 'probe', reasoningEfforts: { high: 'high' } }]]] as const) {
      const option = container.querySelector<HTMLElement>(`[data-value='"${mode}"']`);
      if (!option) throw new Error('Missing reasoning option');
      option.click(); await nextTick();
      expect(models.value).toEqual(expected);
    }
  } finally { app.unmount(); container.remove(); }
});
