import { vi } from 'vitest';
import type { DshJsonValue } from '../../backends/dsh/types';
export function customProviderHarness() {
  let revision = 7;
  const profiles: Record<string, DshJsonValue> = {};
  const call = vi.fn(async (ns: string, method: string, args: Record<string, DshJsonValue> = {}): Promise<DshJsonValue> => {
    if (ns === 'llm') return [];
    if (ns === 'settings' && method === 'describe') return { writable: true, namespaces: [{ ns: 'llm-pi-ai', revision, value: { providers: profiles }, schema: { uid: 1, refs: {
      '1': { type: 'object', dict: { providers: 2 } }, '2': { type: 'dict', inner: 3 },
      '3': { type: 'object', dict: { api: 4 } }, '4': { type: 'union', list: [5, 6] },
      '5': { type: 'const', value: 'openai-completions' }, '6': { type: 'const', value: 'anthropic-messages' },
    } } }] };
    if (ns === 'settings' && method === 'mutate') { revision++; return { revision }; }
    if (ns === 'credentials' && method === 'set') return {};
    throw new Error(`Unexpected ${ns}/${method} ${JSON.stringify(args)}`);
  });
  return { call, profiles };
}
