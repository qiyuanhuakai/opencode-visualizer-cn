import { describe, expect, it, vi } from 'vitest';

import type { KimiWebModelObjectWire } from '../utils/kimiWeb';
import {
  KIMI_WEB_ALL_PROVIDERS_BUSY_ID,
  createKimiWebProvidersClient,
  useKimiWebProviders,
} from './useKimiWebProviders';

const BRIDGE_URL = 'ws://localhost:23004/kimi-web/ws';
const BASE = 'http://localhost:23004/kimi-web';

function envelope(data: unknown, code = 0, msg = 'success') {
  return { code, msg, data, request_id: 'req-1' };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type RouteHandler = () => Response | Promise<Response>;

function createTestClient() {
  const handlers = new Map<string, RouteHandler>();
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const href =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(href);
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url: href,
      body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown),
    });
    const handler = handlers.get(`${method} ${parsed.pathname}`);
    if (!handler) throw new Error(`Unrouted request: ${method} ${parsed.pathname}`);
    return handler();
  });
  const client = createKimiWebProvidersClient({ bridgeUrl: BRIDGE_URL, fetcher });
  return {
    client,
    calls,
    route(method: string, path: string, handler: RouteHandler) {
      handlers.set(`${method} ${path}`, handler);
    },
    putBodies() {
      return calls.filter((call) => call.method === 'PUT').map((call) => call.body);
    },
  };
}

const PROVIDER_WIRE = {
  id: 'custom-openai',
  type: 'openai',
  base_url: 'https://api.example.com/v1',
  default_model: 'custom-openai/gpt-4.1',
  has_api_key: true,
  status: 'connected',
  models: ['custom-openai/gpt-4.1', 'custom-openai/gpt-4.1-mini'],
};

const CONFIG_MODELS: Record<string, KimiWebModelObjectWire> = {
  'custom-openai/gpt-4.1': {
    model: 'gpt-4.1',
    name: 'GPT 4.1',
    max_context_size: 128_000,
    capabilities: ['tool_use'],
  },
  'custom-openai/gpt-4.1-mini': {
    model: 'gpt-4.1-mini',
    name: 'GPT 4.1 mini',
    max_context_size: 32_000,
    capabilities: ['vision', 'thinking'],
  },
};

function routeProviderList(
  harness: ReturnType<typeof createTestClient>,
  items: unknown[] = [PROVIDER_WIRE],
) {
  harness.route('GET', '/kimi-web/api/v1/providers', () => jsonResponse(envelope({ items })));
  harness.route('GET', '/kimi-web/api/v1/config', () =>
    jsonResponse(
      envelope({ default_model: 'custom-openai/gpt-4.1', models: CONFIG_MODELS }),
    ),
  );
  harness.route('GET', '/kimi-web/api/v1/catalog/providers', () =>
    jsonResponse(envelope({ items: [] })),
  );
}

describe('useKimiWebProviders', () => {
  it('loads providers merged with config model details', async () => {
    const harness = createTestClient();
    routeProviderList(harness);
    const providers = useKimiWebProviders({ client: harness.client });

    await expect(providers.load()).resolves.toBe(true);

    expect(providers.error.value).toBeNull();
    expect(providers.loading.value).toBe(false);
    expect(providers.providers.value).toEqual([
      {
        id: 'custom-openai',
        name: 'custom-openai',
        type: 'openai',
        baseUrl: 'https://api.example.com/v1',
        hasApiKey: true,
        status: 'connected',
        defaultModel: 'custom-openai/gpt-4.1',
        models: [
          {
            id: 'gpt-4.1',
            name: 'GPT 4.1',
            providerID: 'custom-openai',
            maxContextSize: 128_000,
            capabilities: { attachment: false, reasoning: false, toolcall: true },
            qualifiedId: 'custom-openai/gpt-4.1',
            source: {
              model: 'gpt-4.1',
              name: 'GPT 4.1',
              max_context_size: 128_000,
              capabilities: ['tool_use'],
            },
          },
          {
            id: 'gpt-4.1-mini',
            name: 'GPT 4.1 mini',
            providerID: 'custom-openai',
            maxContextSize: 32_000,
            capabilities: { attachment: true, reasoning: true, toolcall: false },
            qualifiedId: 'custom-openai/gpt-4.1-mini',
            source: {
              model: 'gpt-4.1-mini',
              name: 'GPT 4.1 mini',
              max_context_size: 32_000,
              capabilities: ['vision', 'thinking'],
            },
          },
        ],
      },
    ]);
    expect(harness.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${BASE}/api/v1/providers`,
      `GET ${BASE}/api/v1/config`,
      `GET ${BASE}/api/v1/catalog/providers`,
    ]);
  });

  it('surfaces an already-exists conflict on create and suggests update', async () => {
    const harness = createTestClient();
    routeProviderList(harness);
    harness.route('POST', '/kimi-web/api/v1/providers', () =>
      jsonResponse(envelope(null, 40921, 'provider custom-openai already exists')),
    );
    const providers = useKimiWebProviders({ client: harness.client });

    const result = await providers.createProvider({
      id: 'custom-openai',
      type: 'openai',
      models: [{ model: 'gpt-4.1', max_context_size: 128_000 }],
    });

    expect(result).toEqual({
      status: 'failed',
      error: {
        kind: 'conflict',
        providerId: 'custom-openai',
        message: 'provider custom-openai already exists',
        suggest: 'update',
      },
    });
    expect(providers.error.value?.kind).toBe('conflict');
    expect(providers.busyProviderId.value).toBeNull();
    // A failed create must not reload or mutate the rendered list.
    expect(harness.calls.filter((call) => call.method === 'GET')).toHaveLength(0);
  });

  it('keeps the existing key when the choice is keep', async () => {
    const harness = createTestClient();
    routeProviderList(harness);
    harness.route('PUT', '/kimi-web/api/v1/providers/custom-openai', () =>
      jsonResponse(envelope({ id: 'custom-openai' })),
    );
    const providers = useKimiWebProviders({ client: harness.client });

    await expect(
      providers.updateProvider('custom-openai', {
        type: 'openai',
        base_url: 'https://api.example.com/v2',
        apiKey: { kind: 'keep' },
        models: [{ model: 'gpt-4.1', name: 'GPT 4.1', max_context_size: 128_000 }],
      }),
    ).resolves.toEqual({ status: 'saved' });

    const [body] = harness.putBodies();
    expect(body).toEqual({
      type: 'openai',
      base_url: 'https://api.example.com/v2',
      models: [{ model: 'gpt-4.1', name: 'GPT 4.1', max_context_size: 128_000 }],
    });
    expect(body).not.toHaveProperty('api_key');
  });

  it('clears the key when the choice is remove', async () => {
    const harness = createTestClient();
    routeProviderList(harness);
    harness.route('PUT', '/kimi-web/api/v1/providers/custom-openai', () =>
      jsonResponse(envelope({ id: 'custom-openai' })),
    );
    const providers = useKimiWebProviders({ client: harness.client });

    await expect(
      providers.updateProvider('custom-openai', {
        type: 'openai',
        apiKey: { kind: 'remove' },
        models: [{ model: 'gpt-4.1', max_context_size: 128_000 }],
      }),
    ).resolves.toEqual({ status: 'saved' });

    const [body] = harness.putBodies();
    expect(body).toEqual({
      type: 'openai',
      api_key: '',
      models: [{ model: 'gpt-4.1', max_context_size: 128_000 }],
    });
  });

  it('replaces the key when the choice is replace', async () => {
    const harness = createTestClient();
    routeProviderList(harness);
    harness.route('PUT', '/kimi-web/api/v1/providers/custom-openai', () =>
      jsonResponse(envelope({ id: 'custom-openai' })),
    );
    const providers = useKimiWebProviders({ client: harness.client });

    await expect(
      providers.updateProvider('custom-openai', {
        type: 'openai',
        apiKey: { kind: 'replace', value: 'sk-new-secret' },
        models: [{ model: 'gpt-4.1', max_context_size: 128_000 }],
      }),
    ).resolves.toEqual({ status: 'saved' });

    const [body] = harness.putBodies();
    expect(body).toEqual({
      type: 'openai',
      api_key: 'sk-new-secret',
      models: [{ model: 'gpt-4.1', max_context_size: 128_000 }],
    });
  });

  it('renders providers when the config fetch fails', async () => {
    const harness = createTestClient();
    harness.route('GET', '/kimi-web/api/v1/providers', () =>
      jsonResponse(envelope({ items: [PROVIDER_WIRE] })),
    );
    harness.route('GET', '/kimi-web/api/v1/config', () => {
      throw new TypeError('Failed to fetch');
    });
    harness.route('GET', '/kimi-web/api/v1/catalog/providers', () =>
      jsonResponse(envelope({ items: [] })),
    );
    const providers = useKimiWebProviders({ client: harness.client });

    await expect(providers.load()).resolves.toBe(true);

    expect(providers.error.value).toBeNull();
    expect(providers.providers.value).toHaveLength(1);
    expect(providers.providers.value[0]?.models).toEqual([
      {
        id: 'gpt-4.1',
        name: 'gpt-4.1',
        providerID: 'custom-openai',
        maxContextSize: undefined,
        capabilities: { attachment: false, reasoning: false, toolcall: false },
        qualifiedId: 'custom-openai/gpt-4.1',
      },
      {
        id: 'gpt-4.1-mini',
        name: 'gpt-4.1-mini',
        providerID: 'custom-openai',
        maxContextSize: undefined,
        capabilities: { attachment: false, reasoning: false, toolcall: false },
        qualifiedId: 'custom-openai/gpt-4.1-mini',
      },
    ]);
  });

  it('sets the global default through an encoded model id', async () => {
    const harness = createTestClient();
    routeProviderList(harness);
    harness.route('POST', '/kimi-web/api/v1/models/custom-openai%2Fgpt-4.1:set_default', () =>
      jsonResponse(envelope({})),
    );
    const providers = useKimiWebProviders({ client: harness.client });

    await expect(providers.setDefaultModel('custom-openai/gpt-4.1')).resolves.toBe(true);

    const call = harness.calls.at(-1);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${BASE}/api/v1/models/custom-openai%2Fgpt-4.1:set_default`);
    expect(call?.url).not.toContain('/models/custom-openai/gpt-4.1:set_default');
    expect(call?.body).toEqual({});
    expect(providers.busyProviderId.value).toBeNull();
  });

  it('distinguishes a business error from a transport failure', async () => {
    const business = createTestClient();
    business.route('GET', '/kimi-web/api/v1/providers', () =>
      jsonResponse(envelope(null, 40001, 'models are required')),
    );
    const businessState = useKimiWebProviders({ client: business.client });

    await expect(businessState.load()).resolves.toBe(false);
    expect(businessState.error.value).toEqual({ kind: 'business', message: 'models are required' });

    const transport = createTestClient();
    transport.route('GET', '/kimi-web/api/v1/providers', () => {
      throw new TypeError('Failed to fetch');
    });
    const transportState = useKimiWebProviders({ client: transport.client });

    await expect(transportState.load()).resolves.toBe(false);
    expect(transportState.error.value).toEqual({
      kind: 'transport',
      message: 'Kimi Web request failed: GET /api/v1/providers',
    });
  });

  it('deletes, refreshes one, refreshes all, and imports through the action routes', async () => {
    const harness = createTestClient();
    routeProviderList(harness);
    harness.route('DELETE', '/kimi-web/api/v1/providers/custom-openai', () =>
      new Response(null, { status: 204 }),
    );
    harness.route('POST', '/kimi-web/api/v1/providers/custom-openai:refresh', () =>
      jsonResponse(envelope({ changed: [], unchanged: [], failed: [] })),
    );
    harness.route('POST', '/kimi-web/api/v1/providers:refresh', () =>
      jsonResponse(envelope({ changed: [], unchanged: [], failed: [] })),
    );
    harness.route('POST', '/kimi-web/api/v1/providers:import_catalog', () =>
      new Response(null, { status: 200 }),
    );
    const providers = useKimiWebProviders({ client: harness.client });

    await expect(providers.deleteProvider('custom-openai')).resolves.toEqual({ status: 'saved' });
    await expect(providers.refreshProvider('custom-openai')).resolves.toEqual({
      status: 'saved',
    });
    await expect(providers.refreshAll()).resolves.toEqual({ status: 'saved' });
    await expect(providers.importCatalog()).resolves.toEqual({ status: 'saved' });

    expect(
      harness.calls
        .filter((call) => call.method === 'POST' || call.method === 'DELETE')
        .map((call) => `${call.method} ${call.url}`),
    ).toEqual([
      `DELETE ${BASE}/api/v1/providers/custom-openai`,
      `POST ${BASE}/api/v1/providers/custom-openai:refresh`,
      `POST ${BASE}/api/v1/providers:refresh`,
      `POST ${BASE}/api/v1/providers:import_catalog`,
    ]);
  });

  it('marks global actions busy with the all-providers sentinel and clears it after', async () => {
    const harness = createTestClient();
    routeProviderList(harness);
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.route('POST', '/kimi-web/api/v1/providers:refresh', async () => {
      await gate;
      return jsonResponse(envelope({ changed: [], unchanged: [], failed: [] }));
    });
    const providers = useKimiWebProviders({ client: harness.client });

    const pending = providers.refreshAll();
    expect(providers.busyProviderId.value).toBe(KIMI_WEB_ALL_PROVIDERS_BUSY_ID);
    release();
    await expect(pending).resolves.toEqual({ status: 'saved' });
    expect(providers.busyProviderId.value).toBeNull();
  });

  it('reports a saved write whose follow-up reload failed', async () => {
    const harness = createTestClient();
    let listCalls = 0;
    harness.route('GET', '/kimi-web/api/v1/providers', () => {
      listCalls += 1;
      if (listCalls > 1) throw new TypeError('Failed to fetch');
      return jsonResponse(envelope({ items: [PROVIDER_WIRE] }));
    });
    harness.route('GET', '/kimi-web/api/v1/config', () =>
      jsonResponse(envelope({ models: CONFIG_MODELS })),
    );
    harness.route('GET', '/kimi-web/api/v1/catalog/providers', () =>
      jsonResponse(envelope({ items: [] })),
    );
    harness.route('DELETE', '/kimi-web/api/v1/providers/custom-openai', () =>
      new Response(null, { status: 204 }),
    );
    const providers = useKimiWebProviders({ client: harness.client });
    await providers.load();

    await expect(providers.deleteProvider('custom-openai')).resolves.toEqual({
      status: 'saved-refresh-failed',
    });
    // The write succeeded, so no error is surfaced; the list keeps the last good data.
    expect(providers.error.value).toBeNull();
    expect(providers.providers.value).toHaveLength(1);
  });

  it('exposes catalog entries and the wire model facts needed to edit a provider', async () => {
    const harness = createTestClient();
    routeProviderList(harness);
    harness.route('GET', '/kimi-web/api/v1/catalog/providers', () =>
      jsonResponse(
        envelope({
          items: [
            {
              id: 'openrouter',
              name: 'OpenRouter',
              env_key: 'OPENROUTER_API_KEY',
              models: [{ model: 'gpt-4.1', max_context_size: 128_000 }],
            },
          ],
        }),
      ),
    );
    const providers = useKimiWebProviders({ client: harness.client });

    await providers.load();

    expect(providers.catalog.value).toEqual([
      {
        id: 'openrouter',
        name: 'OpenRouter',
        env_key: 'OPENROUTER_API_KEY',
        models: [{ model: 'gpt-4.1', max_context_size: 128_000 }],
      },
    ]);
    expect(
      providers.providers.value[0]?.models.map((model) => ({
        qualifiedId: model.qualifiedId,
        capabilities: model.source?.capabilities,
      })),
    ).toEqual([
      { qualifiedId: 'custom-openai/gpt-4.1', capabilities: ['tool_use'] },
      { qualifiedId: 'custom-openai/gpt-4.1-mini', capabilities: ['vision', 'thinking'] },
    ]);
  });
});
