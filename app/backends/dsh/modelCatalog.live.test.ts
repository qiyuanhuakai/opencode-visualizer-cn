import { describe, expect, it } from 'vitest';
import { normalizeDshModelCatalog } from './dshAdapter';

describe('DSH live model catalog', () => {
  it('exposes providers and reasoning efforts from the gateway catalog groups', () => {
    // Given: the captured successful response from dsh 0.2.0-rc.2.
    const catalog = {
      default: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
      routableProviders: ['deepseek-official'],
      groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [
        { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', reasoning: {
          efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high',
        } },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning: {
          efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high',
        } },
      ] }],
      failures: [],
    };
    // When
    const providers = normalizeDshModelCatalog(catalog);
    // Then
    expect(providers).toMatchObject([{
      id: 'deepseek-official',
      models: [{
        id: 'deepseek-flash',
        reasoningEfforts: ['off', 'low', 'high', 'max'],
        defaultReasoningEffort: 'high',
      }, { id: 'deepseek-v4-pro' }],
    }]);
  });
});
