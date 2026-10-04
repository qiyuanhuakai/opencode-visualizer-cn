import { describe, expect, it } from 'vitest';
import { providerHarness } from './dshProviderConfig.fixtures';
import { createDshProviderConfigClient } from './dshProviderConfig';
import type { DshJsonValue } from './types';

describe('DSH provider configuration', () => {
  it('exposes schema-supported effort controls and saves only the provider default', async () => {
    const host = providerHarness();
    host.call.mockResolvedValueOnce([{ provider: 'test', displayName: 'Test', settingsNs: 'custom-ns', settingsPath: [] }]);
    host.call.mockResolvedValueOnce({ writable: true, namespaces: [{ ns: 'custom-ns', revision: 3, value: {}, schema: { uid: 1, refs: { '1': { type: 'object', dict: { reasoning: 2, models: 5, timeoutMs: 8 } }, '2': { type: 'union', list: [3, 4] }, '3': { type: 'const', value: 'off' }, '4': { type: 'const', value: 'high' }, '5': { type: 'array', inner: 6 }, '6': { type: 'object', dict: { reasoningEfforts: 7 } }, '7': { type: 'dict', inner: 3 }, '8': { type: 'number' } } } }] });
    const client = createDshProviderConfigClient(host);
    const row = (await client.load())[0];
    expect(row.fields.map((field) => field.name)).toEqual(['reasoning', 'models']);
    expect(row.fields[1].modelReasoningEfforts).toBe(true);
    await client.save(row, { fields: { reasoning: 'high' }, key: { kind: 'keep' } });
    expect(host.writes[0].args.ops).toEqual([{ op: 'set', path: ['reasoning'], value: 'high' }]);
  });
  it.each<DshJsonValue>([{}, { high: '' }, { unknown: 'high' }, { low: null }])('rejects invalid model reasoning efforts %j before writing', async (reasoningEfforts) => {
    const host = providerHarness();
    const client = createDshProviderConfigClient(host);
    const row = (await client.load())[0];
    await expect(client.save(row, { fields: { models: [{ id: 'model-a', reasoningEfforts }] }, key: { kind: 'keep' } })).rejects.toMatchObject({ code: 'invalid-input' });
    expect(host.writes).toEqual([]);
  });
  it.each([false, { off: null, high: 'high', max: 'ultra' }])('saves valid model reasoning efforts %j', async (reasoningEfforts) => {
    const host = providerHarness();
    const client = createDshProviderConfigClient(host);
    const row = (await client.load())[0];
    await client.save(row, { fields: { models: [{ id: 'model-a', reasoningEfforts }] }, key: { kind: 'keep' } });
    expect(host.profile.models).toEqual([{ id: 'model-a', reasoningEfforts }]);
  });
  it('discovers through the owning runtime namespace and maps native modalities without writing settings', async () => {
    const host = providerHarness();
    const client = createDshProviderConfigClient(host);
    const row = (await client.load())[0];
    if (!row) throw new Error('Missing fixture');
    host.call.mockResolvedValueOnce([{ id: 'vision', name: 'Vision', contextWindow: 8192, maxTokens: 2048, inputModalities: ['text', 'image'] }, { id: 'vision' }]);
    const models = await client.discoverModels(row, { baseURL: 'https://draft.example/v1', api: 'openai-completions', apiKey: 'one-shot-fixture' });
    expect(models).toEqual([{ id: 'vision', name: 'Vision', contextWindow: 8192, maxTokens: 2048, input: ['text', 'image'] }]);
    expect(host.call).toHaveBeenLastCalledWith('llm', 'discoverModels', { settingsNs: 'custom-ns', request: { provider: 'test', baseURL: 'https://draft.example/v1', api: 'openai-completions', apiKey: 'one-shot-fixture' } });
    expect(host.writes).toEqual([]);
  });
  it.each([{ response: {} }, { response: [{ id: '' }] }, { response: [{ id: 'a', contextWindow: -1 }] }, { response: [{ id: 'a', inputModalities: ['audio'] }] }])('rejects malformed discovery metadata $response', async ({ response }) => {
    const host = providerHarness();
    const client = createDshProviderConfigClient(host);
    const row = (await client.load())[0];
    if (!row) throw new Error('Missing fixture');
    host.call.mockResolvedValueOnce(response);
    await expect(client.discoverModels(row, {})).rejects.toMatchObject({ code: 'invalid-response' });
    expect(host.writes).toEqual([]);
  });
  it.each([{ models: [{ id: 'a', maxTokens: '12' }] }, { models: [{ id: 'a' }, { id: 'a' }] }])('rejects invalid graphical model drafts before mutation $models', async ({ models }) => {
    const host = providerHarness();
    const client = createDshProviderConfigClient(host);
    const row = (await client.load())[0];
    if (!row) throw new Error('Missing fixture');
    await expect(client.save(row, { fields: { models }, key: { kind: 'keep' } })).rejects.toMatchObject({ code: 'invalid-input' });
    expect(host.writes).toEqual([]);
  });
  it('loads schema fields, credential state, and server revision without receiving secrets', async () => {
    const host = providerHarness();
    const rows = await createDshProviderConfigClient(host).load();
    expect(rows[0]).toMatchObject({ settingsNs: 'custom-ns', settingsPath: ['providers', 'test'], revision: 3, credential: { configured: true, writable: true }, credentialRef: 'TEST_API_KEY' });
    expect(rows[0]?.fields.find((field) => field.name === 'api')?.choices).toEqual(['openai-completions', 'anthropic-messages']);
    expect(host.writes).toEqual([]);
  });
  it('writes only changed leaves with a revision and reads authoritative state back while preserving keys', async () => {
    const host = providerHarness();
    const client = createDshProviderConfigClient(host);
    const row = (await client.load())[0];
    if (!row) throw new Error('Missing fixture');
    const result = await client.save(row, { fields: { baseURL: 'https://new.example/v1' }, key: { kind: 'keep' } });
    expect(host.writes).toEqual([{ method: 'settings/mutate', args: { ns: 'custom-ns', expectedRevision: 3, ops: [{ op: 'set', path: ['providers', 'test', 'baseURL'], value: 'https://new.example/v1' }] } }]);
    expect(result[0]?.revision).toBe(4);
    expect(result[0]?.fields.find((field) => field.name === 'models')?.value).toEqual([{ id: 'model-a', contextWindow: 1000 }]);
  });
  it('refuses stale writes before touching credentials', async () => {
    const host = providerHarness();
    const client = createDshProviderConfigClient(host);
    const row = (await client.load())[0];
    if (!row) throw new Error('Missing fixture');
    host.bumpRevision();
    await expect(client.save(row, { fields: {}, key: { kind: 'replace', value: 'fixture-only-secret' } })).rejects.toMatchObject({ code: 'settings/conflict' });
    expect(host.writes.map((call) => call.method)).toEqual(['settings/mutate']);
  });
  it.each(['replace', 'remove'] as const)('performs explicit %s only through credential endpoints', async (kind) => {
    const host = providerHarness();
    const client = createDshProviderConfigClient(host);
    const row = (await client.load())[0];
    if (!row) throw new Error('Missing fixture');
    await client.save(row, { fields: {}, key: kind === 'replace' ? { kind, value: 'fixture-only-secret' } : { kind } });
    expect(host.writes.map((call) => call.method)).toEqual(['settings/mutate', kind === 'replace' ? 'credentials/set' : 'credentials/unset']);
    expect(host.writes[1]?.args.ref).toBe('TEST_API_KEY');
    expect(JSON.stringify(host.writes[0])).not.toContain('fixture-only-secret');
  });
  it('rejects blank replacement, invalid URLs, unsupported fields and malformed models before mutation', async () => {
    const host = providerHarness();
    const client = createDshProviderConfigClient(host);
    const row = (await client.load())[0];
    if (!row) throw new Error('Missing fixture');
    for (const patch of [{ fields: {}, key: { kind: 'replace', value: '' } }, { fields: { baseURL: 'file:///tmp' }, key: { kind: 'keep' } }, { fields: { token: 'x' }, key: { kind: 'keep' } }, { fields: { models: [{}] }, key: { kind: 'keep' } }] as const) {
      await expect(client.save(row, patch)).rejects.toMatchObject({ code: 'invalid-input' });
    }
    expect(host.writes).toEqual([]);
  });
  it('can move from a read-only credential to an explicitly selected writable reference', async () => {
    const host = providerHarness();
    const client = createDshProviderConfigClient(host);
    const row = (await client.load())[0];
    if (!row) throw new Error('Missing fixture');
    await client.save({ ...row, credential: { configured: true, writable: false } }, { fields: { apiKeyEnv: 'OWN_API_KEY' }, key: { kind: 'replace', value: 'fixture-only-secret' } });
    expect(host.writes[1]).toEqual({ method: 'credentials/set', args: { ref: 'OWN_API_KEY', value: 'fixture-only-secret' } });
    expect(host.profile.apiKeyEnv).toBe('OWN_API_KEY');
  });
  it('rejects malformed provider responses without showing a successful empty list', async () => {
    const host = providerHarness();
    host.call.mockResolvedValueOnce({});
    await expect(createDshProviderConfigClient(host).load()).rejects.toMatchObject({ code: 'invalid-response' });
  });
});
