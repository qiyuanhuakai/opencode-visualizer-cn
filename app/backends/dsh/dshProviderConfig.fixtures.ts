import { vi } from 'vitest';
import { DshRpcError } from '../../utils/dshRpc';
import type { DshJsonValue } from './types';
export function providerHarness() {
  const writes: { method: string; args: Record<string, DshJsonValue> }[] = [];
  let revision = 3;
  const profile: Record<string, DshJsonValue> = { apiKeyEnv: 'TEST_API_KEY', baseURL: 'https://old.example/v1', models: [{ id: 'model-a', contextWindow: 1000 }] };
  const call = vi.fn(async (ns: string, method: string, args: Record<string, DshJsonValue> = {}): Promise<DshJsonValue> => {
    if (ns === 'llm') return [{ provider: 'test', displayName: 'Test provider', settingsNs: 'custom-ns', settingsPath: ['providers', 'test'], declared: true }];
    if (method === 'describe' && ns === 'settings') return { writable: true, namespaces: [{ ns: 'custom-ns', revision, value: { providers: { test: { ...profile } } }, schema: { uid: 1, refs: { '1': { type: 'object', dict: { providers: 2 } }, '2': { type: 'dict', inner: 3 }, '3': { type: 'object', dict: { baseURL: 4, apiKeyEnv: 4, api: 5, models: 8 } }, '4': { type: 'string' }, '5': { type: 'union', list: [6, 7] }, '6': { type: 'const', value: 'openai-completions' }, '7': { type: 'const', value: 'anthropic-messages' }, '8': { type: 'array', inner: 3 } } } }] };
    if (method === 'describe' && ns === 'credentials') return { TEST_API_KEY: { configured: true, writable: true, source: 'file' }, OWN_API_KEY: { configured: false, writable: true } };
    writes.push({ method: `${ns}/${method}`, args });
    if (ns === 'settings') {
      if (args.expectedRevision !== revision) throw new DshRpcError('Stale revision', { code: 'settings/conflict' });
      revision += 1;
      if (Array.isArray(args.ops)) for (const raw of args.ops) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.path)) continue;
        const key = raw.path.at(-1);
        if (typeof key !== 'string') continue;
        if (raw.op === 'unset') delete profile[key];
        else if (raw.value !== undefined) profile[key] = raw.value;
      }
      return { revision };
    }
    return {};
  });
  return { call, writes, profile, bumpRevision: () => { revision += 1; } };
}

