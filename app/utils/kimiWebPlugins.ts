import { KimiWebError, KimiWebTransportError } from './kimiWeb';
import { kimiWebProxyHttpUrl, kimiWebWsUrl } from './kimiWebWs';

export type KimiWebPlugin = {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly state: 'ok' | 'error';
  readonly version?: string;
};

export type KimiWebPluginCatalogEntry = {
  readonly id: string;
  readonly displayName: string;
  readonly source: string;
  readonly description?: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function plugin(value: unknown): KimiWebPlugin | null {
  if (!record(value)) return null;
  const displayName = value.display_name ?? value.displayName;
  if (typeof value.id !== 'string' || typeof displayName !== 'string' ||
      typeof value.enabled !== 'boolean' || (value.state !== 'ok' && value.state !== 'error')) return null;
  return { id: value.id, displayName, enabled: value.enabled, state: value.state,
    ...(typeof value.version === 'string' ? { version: value.version } : {}) };
}

function catalogEntry(value: unknown): KimiWebPluginCatalogEntry | null {
  if (!record(value)) return null;
  const displayName = value.display_name ?? value.displayName;
  if (typeof value.id !== 'string' || typeof displayName !== 'string' || typeof value.source !== 'string') return null;
  return { id: value.id, displayName, source: value.source,
    ...(typeof value.description === 'string' ? { description: value.description } : {}) };
}

function malformed(path: string) {
  return new KimiWebTransportError('Invalid Kimi Web plugin response.', {
    kind: 'malformed-response',
    path,
  });
}
export function parseKimiWebPluginList(data: unknown): readonly KimiWebPlugin[] {
  const path = '/api/v1/plugins';
  if (!record(data) || !Array.isArray(data.plugins)) throw malformed(path);
  return data.plugins.map(value => {
    const parsed = plugin(value);
    if (!parsed) throw malformed(path);
    return parsed;
  });
}

export function parseKimiWebPluginMarketplace(data: unknown): readonly KimiWebPluginCatalogEntry[] {
  const path = '/api/v1/plugins/marketplace';
  if (!record(data) || !Array.isArray(data.entries)) throw malformed(path);
  return data.entries.map(value => {
    const parsed = catalogEntry(value);
    if (!parsed) throw malformed(path);
    return parsed;
  });
}

export type KimiWebPluginsClient = {
  list(): Promise<readonly KimiWebPlugin[]>;
  marketplace(): Promise<readonly KimiWebPluginCatalogEntry[]>;
  install?: (source: string) => Promise<unknown>;
  action?: (id: string, action: 'enable' | 'disable' | 'remove') => Promise<unknown>;
};

export function createKimiWebPluginsClient(options: {
  readonly bridgeUrl: string;
  readonly bridgeToken?: string;
  readonly fetcher?: typeof fetch;
}) {
  const base = kimiWebProxyHttpUrl(kimiWebWsUrl(options.bridgeUrl, options.bridgeToken ?? ''));
  const send = options.fetcher ?? fetch;
  async function request(path: string, body?: Readonly<Record<string, unknown>>): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.bridgeToken) headers.Authorization = `Bearer ${options.bridgeToken}`;
    let response: Response;
    try {
      response = await send(`${base}${path}`, {
        method: body ? 'POST' : 'GET',
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      throw new KimiWebTransportError('Kimi Web plugin request failed.', {
        kind: 'network',
        path,
        cause,
      });
    }
    if (!response.ok)
      throw new KimiWebTransportError(`Kimi Web plugin request failed (${response.status}).`, {
        kind: 'http-error',
        path,
        status: response.status,
      });
    const payload: unknown = await response.json().catch(() => null);
    if (!record(payload) || typeof payload.code !== 'number') throw malformed(path);
    if (payload.code !== 0)
      throw new KimiWebError(
        payload.code,
        typeof payload.msg === 'string' ? payload.msg : 'Plugin operation failed.',
      );
    return payload.data;
  }
  return {
    list: async () => parseKimiWebPluginList(await request('/api/v1/plugins')),
    marketplace: async () => parseKimiWebPluginMarketplace(await request('/api/v1/plugins/marketplace')),
    install: (source: string) => request('/api/v1/plugins', { source }),
    action: (id: string, action: 'enable' | 'disable' | 'remove') =>
      request(`/api/v1/plugins/${encodeURIComponent(id)}:${action}`, {}),
  };
}
