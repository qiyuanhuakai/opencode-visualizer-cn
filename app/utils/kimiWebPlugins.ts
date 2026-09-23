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

function plugin(value: unknown): value is KimiWebPlugin {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    typeof value.displayName === 'string' &&
    typeof value.enabled === 'boolean' &&
    (value.state === 'ok' || value.state === 'error')
  );
}

function catalogEntry(value: unknown): value is KimiWebPluginCatalogEntry {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    typeof value.displayName === 'string' &&
    typeof value.source === 'string'
  );
}

export function createKimiWebPluginsClient(options: {
  readonly bridgeUrl: string;
  readonly bridgeToken?: string;
  readonly fetcher?: typeof fetch;
}) {
  const base = kimiWebProxyHttpUrl(kimiWebWsUrl(options.bridgeUrl, options.bridgeToken ?? ''));
  const send = options.fetcher ?? fetch;
  function malformed(path: string) {
    return new KimiWebTransportError('Invalid Kimi Web plugin response.', {
      kind: 'malformed-response',
      path,
    });
  }
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
    async list(): Promise<readonly KimiWebPlugin[]> {
      const path = '/api/v1/plugins';
      const data = await request(path);
      if (!record(data) || !Array.isArray(data.plugins) || !data.plugins.every(plugin))
        throw malformed(path);
      return data.plugins;
    },
    async marketplace(): Promise<readonly KimiWebPluginCatalogEntry[]> {
      const path = '/api/v1/plugins/marketplace';
      const data = await request(path);
      if (!record(data) || !Array.isArray(data.entries) || !data.entries.every(catalogEntry))
        throw malformed(path);
      return data.entries;
    },
    install: (source: string) => request('/api/v1/plugins', { source }),
    action: (id: string, action: 'enable' | 'disable' | 'remove') =>
      request(`/api/v1/plugins/${encodeURIComponent(id)}:${action}`, {}),
  };
}

export type KimiWebPluginsClient = ReturnType<typeof createKimiWebPluginsClient>;
