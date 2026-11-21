import { jsonValue, requireValue } from '../../shared/runtime/capabilities.js';
import type { HarnessManifest } from '../../shared/runtime/harnessContract.js';
import { KIMI_PROVIDER_OPERATIONS } from '../../shared/runtime/native/kimiWeb/providerOperations.js';
import { KIMI_SESSION_OPERATIONS } from '../../shared/runtime/native/kimiWeb/sessionOperations.js';
import { parseSessionRef, type SessionRef } from '../../shared/runtime/identity.js';
import { createKimiWebClient, KimiWebError } from '../utils/kimiWeb';
import { parseKimiWebPluginList, parseKimiWebPluginMarketplace, type KimiWebPluginsClient } from '../utils/kimiWebPlugins';
import type { KimiWebProviderConfigWire, KimiWebProvidersClient } from '../composables/useKimiWebProviders';
import type { RuntimeClient } from './client';
import { createNativeFacade } from './nativeFacade';

export function createNativeKimiSessionClient(client: RuntimeClient, manifest: HarnessManifest, session?: SessionRef) {
  const facade = createNativeFacade(client, manifest, session);
  const scope = client.scope(manifest.environmentId);
  const createdSessions = new Set<string>();
  const pendingDiscovery = new Set<string>();
  const native = createKimiWebClient({
    baseUrl: '',
    async requestJson(spec) {
      if (spec.method === 'GET' && spec.path === '/api/v1/meta') return facade.query('kimi.meta');
      if (session) {
        const matchedId = /^\/api\/v1\/sessions\/([^/:]+)(?=[:/]|$)/.exec(spec.path)?.[1];
        const nativeSessionId = matchedId ? decodeURIComponent(matchedId) : session.nativeSessionId;
        requireValue(nativeSessionId === session.nativeSessionId || createdSessions.has(nativeSessionId), 'kimi.session_scope', 'unauthorized');
        if (pendingDiscovery.has(nativeSessionId)) {
          await client.request(manifest.environmentId, 'session.list', { harnessInstanceId: manifest.harnessInstanceId, args: {} }, { selectionCurrent: scope.isCurrent });
          pendingDiscovery.delete(nativeSessionId);
        }
        requireValue(scope.isCurrent(), 'kimi.session_generation', 'reconcile_required');
        const sessionFacade = nativeSessionId === session.nativeSessionId ? facade : createNativeFacade(client, manifest, parseSessionRef({ ...session, nativeSessionId }));
        const prefix = `/api/v1/sessions/${encodeURIComponent(nativeSessionId)}`;
        const routes = {
          ...KIMI_SESSION_OPERATIONS,
          'kimi.updateProfile': { method: 'POST', suffix: '/profile' },
          archiveSession: { method: 'POST', suffix: ':archive' },
          restoreSession: { method: 'POST', suffix: ':restore' },
          deleteSession: { method: 'POST', suffix: ':delete' },
          'kimi.sessionStatus': { method: 'GET', suffix: '/status' },
        };
        for (const [name, route] of Object.entries(routes)) {
          if (spec.method !== route.method || !spec.path.startsWith(prefix)) continue;
          const suffix = spec.path.slice(prefix.length);
          const [before, after] = route.suffix.split('{id}');
          let id: string | undefined;
          if (after === undefined) { if (suffix !== route.suffix) continue; }
          else {
            if (!suffix.startsWith(before!) || !suffix.endsWith(after)) continue;
            const encoded = suffix.slice(before!.length, after ? -after.length : undefined);
            if (!encoded || encoded.includes('/')) continue;
            id = decodeURIComponent(encoded);
          }
          const query = Object.fromEntries(Object.entries(spec.query ?? {}).filter(([, value]) => value !== undefined && value !== null));
          const args = { ...(id === undefined ? {} : { id }), ...(Object.keys(query).length ? { query: jsonValue(query) } : {}), ...(spec.body === undefined ? {} : { body: jsonValue(spec.body) }) };
          if (route.method === 'GET') return sessionFacade.query(name, args);
          const mutation = sessionFacade.mutate(name, args);
          void mutation.accepted.catch(() => undefined);
          const result = (await mutation.executed).value;
          if ((name === 'forkSession' || name === 'kimi.children.create') && result !== null && typeof result === 'object' && !Array.isArray(result) && 'id' in result && typeof result.id === 'string') {
            const created = parseSessionRef({ ...session, nativeSessionId: result.id });
            createdSessions.add(created.nativeSessionId);
            pendingDiscovery.add(created.nativeSessionId);
            while (createdSessions.size > 3) {
              const oldest = createdSessions.values().next().value;
              if (oldest === undefined) break;
              createdSessions.delete(oldest);
              pendingDiscovery.delete(oldest);
            }
          }
          return result;
        }
      }
      for (const [name, route] of Object.entries(KIMI_PROVIDER_OPERATIONS)) {
        if (route.method !== spec.method) continue;
        const [prefix, suffix] = route.path.split('{id}');
        const hasId = suffix !== undefined;
        if (hasId ? !spec.path.startsWith(prefix!) || !spec.path.endsWith(suffix) : spec.path !== route.path) continue;
        const encodedId = hasId ? spec.path.slice(prefix!.length, suffix ? -suffix.length : undefined) : undefined;
        if (encodedId?.includes('/')) continue;
        const args = { ...(encodedId ? { id: decodeURIComponent(encodedId) } : {}), ...(spec.body === undefined ? {} : { body: jsonValue(spec.body) }) };
        if (route.method === 'GET') return facade.query(name, args);
        const mutation = facade.mutate(name, args);
        void mutation.accepted.catch(() => undefined);
        const result = (await mutation.executed).value;
        if (result !== null && typeof result === 'object' && '__kimiBusinessError' in result && typeof result.__kimiBusinessError === 'number') {
          throw new KimiWebError(result.__kimiBusinessError, result.__kimiBusinessError === 40921 ? 'Provider settings changed. Reload the configuration and retry.' : `Kimi rejected this operation (${result.__kimiBusinessError}).`);
        }
        return result;
      }
      throw new Error(`runtime.kimi: undeclared provider operation ${spec.method} ${spec.path}`);
    },
  });
  return { ...native, canUpdateGoalObjective: manifest.extensions.some(entry => entry.name === 'kimi.goal.update' && entry.support.state === 'supported') };
}

export function createNativeKimiProviders(client: RuntimeClient, manifest: HarnessManifest): KimiWebProvidersClient {
  const facade = createNativeFacade(client, manifest);
  const native = createNativeKimiSessionClient(client, manifest);
  return {
    ...native,
    async getKimiWebConfig() {
      const value = await facade.query('kimi.config.get');
      requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'kimi.config');
      return value as KimiWebProviderConfigWire;
    },
  };
}

export function createNativeKimiPlugins(client: RuntimeClient, manifest: HarnessManifest): KimiWebPluginsClient | null {
  const supported = new Set(manifest.extensions.filter(entry => entry.support.state === 'supported').map(entry => entry.name));
  if (!supported.has('kimi.plugins.list')) return null;
  const facade = createNativeFacade(client, manifest);
  async function mutate(operation: string, args: Record<string, string>) {
    const mutation = facade.mutate(operation, args);
    void mutation.accepted.catch(() => undefined);
    const { value } = await mutation.executed;
    const result = value && typeof value === 'object' && 'result' in value ? value.result : null;
    if (result && typeof result === 'object' && '__kimiBusinessError' in result
        && typeof result.__kimiBusinessError === 'number') {
      throw new KimiWebError(result.__kimiBusinessError, 'Plugin operation failed.');
    }
    return result;
  }
  return {
    list: async () => parseKimiWebPluginList(await facade.query('kimi.plugins.list')),
    marketplace: async () => supported.has('kimi.plugins.marketplace')
      ? parseKimiWebPluginMarketplace(await facade.query('kimi.plugins.marketplace')) : [],
    install: supported.has('kimi.plugins.install') ? source => mutate('kimi.plugins.install', { source }) : undefined,
    action: supported.has('kimi.plugins.action') ? (id, action) => mutate('kimi.plugins.action', { id, action }) : undefined,
  };
}
