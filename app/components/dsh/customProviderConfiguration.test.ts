import { expect, it } from 'vitest';
import { customProviderHarness } from './customProviderConfiguration.fixtures';
import { readCustomProviderContext, validateCustomProvider, writeCustomProvider, type CustomProviderDraft } from './customProviderConfiguration';

const draft: CustomProviderDraft = { id: 'local-models', name: 'Local models', baseURL: 'https://local.example/v1', protocol: 'openai-completions', apiKey: '', models: [{ id: 'model-a', name: 'Model A' }] };
it('reads native namespace revision and protocol choices and writes one CAS profile mutation', async () => {
  const rpc = customProviderHarness();
  const context = await readCustomProviderContext(rpc);
  expect(context.protocols).toEqual(['openai-completions', 'anthropic-messages']);
  await writeCustomProvider(rpc, context, draft);
  expect(rpc.call).toHaveBeenLastCalledWith('settings', 'mutate', { ns: 'llm-pi-ai', expectedRevision: 7, ops: [{ op: 'set', path: ['providers', 'local-models'], value: {
    displayName: 'Local models', baseURL: 'https://local.example/v1', api: 'openai-completions', models: [{ id: 'model-a', name: 'Model A' }],
  } }] });
  expect(rpc.call.mock.calls.some(([ns]) => ns === 'credentials')).toBe(false);
});
it('records the credential reference without putting the secret in the settings document', async () => {
  const rpc = customProviderHarness();
  await writeCustomProvider(rpc, await readCustomProviderContext(rpc), { ...draft, apiKey: 'test-key' });
  expect(JSON.stringify(rpc.call.mock.calls.at(-1))).toContain('LOCAL_MODELS_API_KEY');
  expect(JSON.stringify(rpc.call.mock.calls.at(-1))).not.toContain('test-key');
});
it('rejects duplicate routes and invalid models before a write', async () => {
  const rpc = customProviderHarness(); rpc.profiles['local-models'] = {};
  const context = await readCustomProviderContext(rpc);
  await expect(writeCustomProvider(rpc, context, draft)).rejects.toThrow('unique provider ID');
  expect(() => validateCustomProvider({ ...context, taken: [] }, { ...draft, models: [] })).toThrow('model ID');
  expect(() => validateCustomProvider({ ...context, taken: [] }, { ...draft, models: [draft.models[0] ?? { id: 'a', name: '' }, draft.models[0] ?? { id: 'a', name: '' }] })).toThrow('unique');
  expect(rpc.call.mock.calls.some(([, method]) => method === 'mutate')).toBe(false);
});
it('rejects non-native custom schemas instead of inventing an endpoint', async () => {
  await expect(readCustomProviderContext({ call: async () => ({ writable: true, namespaces: [] }) })).rejects.toThrow('does not expose');
});
