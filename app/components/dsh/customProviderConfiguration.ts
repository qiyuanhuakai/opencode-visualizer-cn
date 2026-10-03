import type { DshRpcClient } from '../../utils/dshRpc';
import type { DshJsonValue } from '../../backends/dsh/types';
import { DshProviderConfigError } from '../../backends/dsh/dshProviderConfig';

export type CustomProviderContext = {
  readonly revision: number;
  readonly writable: boolean;
  readonly protocols: readonly string[];
  readonly taken: readonly string[];
};
export type CustomProviderDraft = {
  readonly id: string;
  readonly name: string;
  readonly baseURL: string;
  readonly protocol: string;
  readonly apiKey: string;
  readonly models: readonly { readonly id: string; readonly name: string }[];
};
function isObject(value: DshJsonValue | undefined): value is { readonly [key: string]: DshJsonValue } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function object(value: DshJsonValue | undefined) {
  if (!isObject(value)) throw new DshProviderConfigError('invalid-response', 'Custom provider settings are unavailable');
  return value;
}
export async function readCustomProviderContext(rpc: Pick<DshRpcClient, 'call'>): Promise<CustomProviderContext> {
  const settings = object(await rpc.call('settings', 'describe', {}));
  if (!Array.isArray(settings.namespaces)) throw new DshProviderConfigError('invalid-response', 'Custom provider settings are unavailable');
  const ns = settings.namespaces.map(object).find((entry) => entry.ns === 'llm-pi-ai');
  if (!ns || typeof ns.revision !== 'number' || !Number.isSafeInteger(ns.revision)) throw new DshProviderConfigError('invalid-response', 'This runtime does not expose custom provider settings');
  const schema = object(ns.schema);
  const refs = object(schema.refs);
  const root = object(refs[String(schema.uid)]);
  const providers = object(refs[String(object(root.dict).providers)]);
  if (providers.type !== 'dict') throw new DshProviderConfigError('invalid-response', 'Custom provider schema does not allow new routes');
  const fields = object(object(refs[String(providers.inner)]).dict);
  const api = object(refs[String(fields.api)]);
  if (!Array.isArray(api.list)) throw new DshProviderConfigError('invalid-response', 'Custom provider protocol choices are unavailable');
  const protocols = api.list.map((id) => object(refs[String(id)]).value).filter((value): value is string => typeof value === 'string');
  if (!protocols.length) throw new DshProviderConfigError('invalid-response', 'Custom provider protocol choices are unavailable');
  const configured = object(ns.value).providers;
  const directory = await rpc.call('llm', 'listConfigurableProviders', {});
  if (!Array.isArray(directory)) throw new DshProviderConfigError('invalid-response', 'Provider directory is unavailable');
  return { revision: ns.revision, writable: settings.writable === true, protocols,
    taken: [...Object.keys(configured === undefined ? {} : object(configured)), ...directory.map(object).map((entry) => entry.provider).filter((value): value is string => typeof value === 'string')] };
}
export function validateCustomProvider(context: CustomProviderContext, draft: CustomProviderDraft): void {
  if (!context.writable) throw new DshProviderConfigError('readonly', 'DSH settings are read-only');
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(draft.id) || context.taken.includes(draft.id)) throw new DshProviderConfigError('invalid-input', 'Enter a unique provider ID using lowercase letters, numbers and hyphens');
  let url: URL;
  try { url = new URL(draft.baseURL); } catch (reason) {
    if (reason instanceof TypeError) throw new DshProviderConfigError('invalid-input', 'Enter an HTTP(S) base URL');
    throw reason;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new DshProviderConfigError('invalid-input', 'Base URL must be HTTP(S) without credentials, query or fragment');
  if (!context.protocols.includes(draft.protocol)) throw new DshProviderConfigError('invalid-input', 'Select a supported API protocol');
  if (!draft.models.length || draft.models.some((model) => !model.id.trim())) throw new DshProviderConfigError('invalid-input', 'Add at least one model ID');
  if (new Set(draft.models.map((model) => model.id.trim())).size !== draft.models.length) throw new DshProviderConfigError('invalid-input', 'Model IDs must be unique');
}
export async function writeCustomProvider(rpc: Pick<DshRpcClient, 'call'>, context: CustomProviderContext, draft: CustomProviderDraft): Promise<void> {
  validateCustomProvider(context, draft);
  const profile: Record<string, DshJsonValue> = {
    baseURL: draft.baseURL.trim(), api: draft.protocol,
    models: draft.models.map((model) => ({ id: model.id.trim(), ...(model.name.trim() ? { name: model.name.trim() } : {}) })),
  };
  if (draft.name.trim()) profile.displayName = draft.name.trim();
  if (draft.apiKey.trim()) profile.apiKeyEnv = customProviderKeyRef(draft.id);
  await rpc.call('settings', 'mutate', { ns: 'llm-pi-ai', expectedRevision: context.revision, ops: [{ op: 'set', path: ['providers', draft.id], value: profile }] });
}
export function customProviderKeyRef(id: string): string { return `${id.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}_API_KEY`; }
