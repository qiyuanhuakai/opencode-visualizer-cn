import { DshRpcError, type DshRpcClient } from '../../utils/dshRpc';
import { isDshJsonValue, type DshJsonValue } from './types';

type JsonObject = { [key: string]: DshJsonValue };
export const dshReasoningLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type DshProviderField = {
  readonly name: string;
  readonly kind: 'string' | 'choice' | 'models';
  readonly choices: readonly string[];
  readonly value: DshJsonValue | undefined;
  readonly modelInputField?: 'input' | 'inputModalities';
  readonly modelReasoningEfforts?: boolean;
};
export type DshProviderConfiguration = {
  readonly provider: string;
  readonly displayName: string;
  readonly settingsNs: string;
  readonly settingsPath: readonly string[];
  readonly revision: number;
  readonly writable: boolean;
  readonly declared: boolean;
  readonly fields: readonly DshProviderField[];
  readonly credentialRef?: string;
  readonly credential?: { readonly configured: boolean; readonly writable: boolean; readonly source?: string };
};
export type DshProviderPatch = {
  readonly fields: Readonly<Record<string, DshJsonValue | undefined>>;
  readonly key: { readonly kind: 'keep' } | { readonly kind: 'replace'; readonly value: string } | { readonly kind: 'remove' };
};
export type DshProviderConfigClient = {
  load(): Promise<DshProviderConfiguration[]>;
  save(provider: DshProviderConfiguration, patch: DshProviderPatch): Promise<DshProviderConfiguration[]>;
  discoverModels(provider: DshProviderConfiguration, draft: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<JsonObject[]>;
};
export class DshProviderConfigError extends Error {
  constructor(readonly code: 'invalid-response' | 'invalid-input' | 'readonly', message: string) {
    super(message);
    this.name = 'DshProviderConfigError';
  }
}
function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && isDshJsonValue(value);
}
function object(value: unknown): JsonObject {
  if (!isObject(value)) {
    throw new DshProviderConfigError('invalid-response', 'Invalid DSH provider settings response');
  }
  return value;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new DshProviderConfigError('invalid-response', 'Invalid DSH provider identifier');
  return value;
}
function path(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((part): part is string => typeof part === 'string')) {
    throw new DshProviderConfigError('invalid-response', 'Invalid DSH settings path');
  }
  return value;
}
function at(value: DshJsonValue | undefined, keys: readonly string[]): DshJsonValue | undefined {
  for (const key of keys) {
    if (!isObject(value)) return undefined;
    value = value[key];
  }
  return value;
}
function schemaFields(schemaValue: DshJsonValue | undefined, keys: readonly string[], value: DshJsonValue | undefined): DshProviderField[] {
  const schema = object(schemaValue);
  const refs = object(schema.refs);
  let node = object(refs[String(schema.uid)]);
  for (const key of keys) {
    const id = node.type === 'dict' ? node.inner : object(node.dict)[key];
    node = object(refs[String(id)]);
  }
  if (node.type !== 'object') return [];
  const fields: DshProviderField[] = [];
  for (const [name, id] of Object.entries(object(node.dict))) {
    if (!['displayName', 'baseURL', 'api', 'apiKeyEnv', 'models', 'reasoning'].includes(name)) continue;
    const field = object(refs[String(id)]);
    if (name === 'models' && field.type === 'array') {
      const model = object(refs[String(field.inner)]);
      const members = object(model.dict);
      const modelInputField = Object.hasOwn(members, 'inputModalities') ? 'inputModalities' : 'input';
      fields.push({ name, kind: 'models', choices: [], value: at(value, [name]), modelInputField, modelReasoningEfforts: Object.hasOwn(members, 'reasoningEfforts') });
    } else if (field.type === 'string') {
      fields.push({ name, kind: 'string', choices: [], value: at(value, [name]) });
    } else if (field.type === 'union' && Array.isArray(field.list)) {
      const choices = field.list.map((ref) => object(refs[String(ref)]).value).filter((item): item is string => typeof item === 'string');
      if (choices.length) fields.push({ name, kind: 'choice', choices, value: at(value, [name]) });
    }
  }
  return fields;
}
export function createDshProviderConfigClient(rpc: Pick<DshRpcClient, 'call'>): DshProviderConfigClient {
  async function load(): Promise<DshProviderConfiguration[]> {
    const [directory, description] = await Promise.all([rpc.call('llm', 'listConfigurableProviders', {}), rpc.call('settings', 'describe', {})]);
    if (!Array.isArray(directory)) throw new DshProviderConfigError('invalid-response', 'Invalid DSH provider directory');
    const settings = object(description);
    if (typeof settings.writable !== 'boolean' || !Array.isArray(settings.namespaces)) throw new DshProviderConfigError('invalid-response', 'Invalid DSH settings description');
    const namespaces = settings.namespaces.map(object);
    const rows: DshProviderConfiguration[] = directory.map((raw) => {
      const entry = object(raw);
      const provider = string(entry.provider);
      const settingsNs = string(entry.settingsNs);
      const settingsPath = path(entry.settingsPath);
      const namespace = namespaces.find((item) => item.ns === settingsNs);
      if (!namespace || typeof namespace.revision !== 'number' || !Number.isSafeInteger(namespace.revision)) throw new DshProviderConfigError('invalid-response', 'Missing DSH provider namespace revision');
      const profile = at(namespace.value, settingsPath);
      const fields = schemaFields(namespace.schema, settingsPath, profile);
      const reference = at(profile, ['apiKeyEnv']);
      const credentialRef = fields.some((field) => field.name === 'apiKeyEnv')
        ? typeof reference === 'string' && reference ? reference : `${provider.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}_API_KEY`
        : undefined;
      return { provider, displayName: string(entry.displayName), settingsNs, settingsPath, revision: namespace.revision,
        writable: settings.writable === true, declared: entry.declared === true || profile !== undefined, fields, credentialRef };
    });
    const refs = [...new Set(rows.flatMap((row) => row.credentialRef ? [row.credentialRef] : []))];
    const credentials = refs.length ? object(await rpc.call('credentials', 'describe', { refs })) : {};
    return rows.map((row) => {
      if (!row.credentialRef) return row;
      const info = object(credentials[row.credentialRef]);
      if (typeof info.configured !== 'boolean' || typeof info.writable !== 'boolean') throw new DshProviderConfigError('invalid-response', 'Invalid DSH credential status');
      return { ...row, credential: { configured: info.configured, writable: info.writable, ...(typeof info.source === 'string' ? { source: info.source } : {}) } };
    });
  }
  async function save(provider: DshProviderConfiguration, patch: DshProviderPatch): Promise<DshProviderConfiguration[]> {
    if (!provider.writable) throw new DshProviderConfigError('readonly', 'DSH settings are read-only');
    const ops: DshJsonValue[] = [];
    for (const [name, value] of Object.entries(patch.fields)) {
      const field = provider.fields.find((candidate) => candidate.name === name);
      if (!field) throw new DshProviderConfigError('invalid-input', `Unsupported provider field: ${name}`);
      if (value !== undefined) {
        if (field.kind === 'models') {
          if (!Array.isArray(value) || !value.every((model) => model && typeof model === 'object' && !Array.isArray(model) && typeof model.id === 'string' && model.id.trim())) throw new DshProviderConfigError('invalid-input', 'Models must be a JSON array of objects with an id');
          const ids = new Set<string>();
          for (const item of value) {
            const model = object(item);
            const id = string(model.id).trim();
            if (ids.has(id)) throw new DshProviderConfigError('invalid-input', 'Model IDs must be unique');
            ids.add(id);
            const efforts = model.reasoningEfforts;
            if (efforts !== undefined && efforts !== false && (!isObject(efforts) || !Object.keys(efforts).length || Object.entries(efforts).some(([level, wire]) => !dshReasoningLevels.some((item) => item === level) || (level === 'off' && (wire === null || wire === '') ? false : typeof wire !== 'string' || !wire.trim())))) {
              throw new DshProviderConfigError('invalid-input', 'Select at least one valid reasoning effort and supply its wire value');
            }
            for (const name of ['contextWindow', 'maxTokens']) {
              const capacity = model[name];
              if (capacity !== undefined && (typeof capacity !== 'number' || !Number.isSafeInteger(capacity) || capacity <= 0)) throw new DshProviderConfigError('invalid-input', 'Model capacities must be positive whole numbers');
            }
          }
        } else if (typeof value !== 'string' || (field.kind === 'choice' && !field.choices.includes(value))) {
          throw new DshProviderConfigError('invalid-input', `Invalid provider field: ${name}`);
        }
        if (name === 'apiKeyEnv' && (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value))) throw new DshProviderConfigError('invalid-input', 'Invalid credential reference');
        if (name === 'baseURL' && typeof value === 'string') {
          let url: URL;
          try { url = new URL(value); } catch (error) { if (error instanceof TypeError) throw new DshProviderConfigError('invalid-input', 'Base URL must be an HTTP(S) URL'); throw error; }
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new DshProviderConfigError('invalid-input', 'Base URL must be HTTP(S) without credentials, query, or fragment');
        }
      }
      if (JSON.stringify(value) === JSON.stringify(field.value)) continue;
      ops.push(value === undefined ? { op: 'unset', path: [...provider.settingsPath, name] } : { op: 'set', path: [...provider.settingsPath, name], value });
    }
    const nextReference = Object.hasOwn(patch.fields, 'apiKeyEnv') ? patch.fields.apiKeyEnv : provider.credentialRef;
    const keyRef = typeof nextReference === 'string' && nextReference ? nextReference : provider.credentialRef;
    if (patch.key.kind !== 'keep') {
      if (!keyRef || !provider.credential || (keyRef === provider.credentialRef && !provider.credential.writable)) throw new DshProviderConfigError('readonly', 'This credential is read-only');
      if (patch.key.kind === 'replace' && !patch.key.value.trim()) throw new DshProviderConfigError('invalid-input', 'Enter a replacement API key');
      if (patch.key.kind === 'remove' && keyRef !== provider.credentialRef) throw new DshProviderConfigError('invalid-input', 'Save the credential reference before removing its key');
      if (patch.key.kind === 'replace' && (Object.hasOwn(patch.fields, 'apiKeyEnv') ? !patch.fields.apiKeyEnv : !provider.fields.find((field) => field.name === 'apiKeyEnv')?.value)) {
        ops.push({ op: 'set', path: [...provider.settingsPath, 'apiKeyEnv'], value: keyRef });
      }
    }
    if (patch.key.kind === 'replace' && keyRef && keyRef !== provider.credentialRef) {
      const state = object(await rpc.call('credentials', 'describe', { refs: [keyRef] }));
      if (object(state[keyRef]).writable !== true) throw new DshProviderConfigError('readonly', 'This credential is read-only');
    }
    // Even a credential-only change checks the settings revision before touching a secret.
    if (ops.length || patch.key.kind !== 'keep') await rpc.call('settings', 'mutate', { ns: provider.settingsNs, ops, expectedRevision: provider.revision });
    switch (patch.key.kind) {
      case 'keep': break;
      case 'replace': await rpc.call('credentials', 'set', { ref: keyRef ?? '', value: patch.key.value }); break;
      case 'remove': await rpc.call('credentials', 'unset', { ref: keyRef ?? '' }); break;
    }
    return load();
  }
  async function discoverModels(provider: DshProviderConfiguration, draft: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<JsonObject[]> {
    const request: JsonObject = { provider: provider.provider };
    for (const name of ['baseURL', 'api', 'apiKey']) {
      if (draft[name]?.trim()) request[name] = draft[name].trim();
    }
    const args = { settingsNs: provider.settingsNs, request };
    const result = await (signal ? rpc.call('llm', 'discoverModels', args, { signal }) : rpc.call('llm', 'discoverModels', args));
    if (!Array.isArray(result)) throw new DshProviderConfigError('invalid-response', 'Invalid DSH model discovery response');
    const models = new Map<string, JsonObject>();
    for (const value of result) {
      const model = object(value);
      const id = string(model.id).trim();
      if (!id) throw new DshProviderConfigError('invalid-response', 'Invalid DSH model identifier');
      const profile: JsonObject = { id };
      if (model.name !== undefined) profile.name = string(model.name);
      for (const name of ['contextWindow', 'maxTokens']) {
        const number = model[name];
        if (number === undefined) continue;
        if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) throw new DshProviderConfigError('invalid-response', 'Invalid DSH model capacity');
        profile[name] = number;
      }
      if (model.inputModalities !== undefined) {
        if (!Array.isArray(model.inputModalities) || !model.inputModalities.every((item) => item === 'text' || item === 'image')) throw new DshProviderConfigError('invalid-response', 'Invalid DSH model modalities');
        profile[provider.fields.find((field) => field.kind === 'models')?.modelInputField ?? 'input'] = model.inputModalities;
      }
      if (!models.has(id)) models.set(id, profile);
    }
    return [...models.values()];
  }
  return { load, save, discoverModels };
}
export function isDshProviderConflict(error: unknown): boolean {
  return error instanceof DshRpcError && error.code === 'settings/conflict';
}
