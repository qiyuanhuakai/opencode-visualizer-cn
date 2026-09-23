import { ref } from 'vue';
import {
  KimiWebError,
  KimiWebTransportError,
  createKimiWebClient,
  type KimiWebClient,
  type KimiWebModelObjectWire,
  type KimiWebProviderCatalogEntryWire,
  type KimiWebProviderCreateInput,
  type KimiWebProviderType,
  type KimiWebProviderUpdateInput,
  type KimiWebProviderWire,
} from '../utils/kimiWeb';
import { kimiWebProxyHttpUrl, kimiWebWsUrl } from '../utils/kimiWebWs';
import {
  mapKimiWebProvidersToProviderInfo,
  type KimiWebManagedProvider,
  type KimiWebManagedProviderModel,
  type KimiWebManagedProviderSource,
} from '../backends/kimiWeb/kimiWebProviderMapping';

/**
 * `GET /api/v1/config`: `models` is keyed by qualified id and holds the
 * authoritative model objects the mapper needs for context size/capabilities.
 */
export type KimiWebProviderConfigWire = {
  readonly default_model?: string;
  readonly models?: Record<string, KimiWebModelObjectWire>;
};

/**
 * The kimi REST client plus the measured config reader. The shared client
 * (app/utils/kimiWeb.ts) predates the provider-management surface and has no
 * config method, so the production wiring composes one on top of it.
 */
export type KimiWebProvidersClient = KimiWebClient & {
  readonly getKimiWebConfig: () => Promise<KimiWebProviderConfigWire>;
};

/**
 * Explicit key intent for `PUT /providers/{id}`: omitting `api_key` preserves
 * the existing key, `''` clears it. A bare optional string could silently
 * clear a key on a UI bug, so the choice is discriminated instead.
 */
export type KimiWebApiKeyChoice =
  | { readonly kind: 'keep' }
  | { readonly kind: 'replace'; readonly value: string }
  | { readonly kind: 'remove' };

export type KimiWebProviderUpdateRequest = {
  readonly type: KimiWebProviderType;
  readonly base_url?: string;
  readonly models: readonly KimiWebModelObjectWire[];
  readonly apiKey: KimiWebApiKeyChoice;
};

export type KimiWebProvidersError =
  | {
      readonly kind: 'conflict';
      readonly providerId: string;
      readonly message: string;
      readonly suggest: 'update';
    }
  | { readonly kind: 'business'; readonly message: string }
  | { readonly kind: 'transport'; readonly message: string };

export type KimiWebProviderSaveResult =
  | { readonly status: 'saved' }
  | { readonly status: 'saved-refresh-failed' }
  | { readonly status: 'failed'; readonly error: KimiWebProvidersError };

/** Mapped model plus the wire facts the management surface round-trips. */
export type KimiWebManagedProviderModelEntry = KimiWebManagedProviderModel & {
  /** Qualified wire id (`{provider}/{model}`) required by `:set_default`. */
  readonly qualifiedId: string;
  /** Authoritative config model object, present when the config read succeeded. */
  readonly source?: KimiWebModelObjectWire;
};

/** Mapped provider plus the wire `type`, which the mapper intentionally drops. */
export type KimiWebManagedProviderEntry = Omit<KimiWebManagedProvider, 'models'> & {
  readonly type: KimiWebProviderType;
  readonly models: readonly KimiWebManagedProviderModelEntry[];
};

/** Busy id marking an action that spans every provider (refresh all / import). */
export const KIMI_WEB_ALL_PROVIDERS_BUSY_ID = '*';

const CONFIG_PATH = '/api/v1/config';
const CONFLICT_CODE = 40921;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads `GET /api/v1/config` through the bridge proxy root with the same
 * envelope contract as the shared client: HTTP 200 with a non-zero `code` is a
 * business failure; anything else is a transport failure.
 */
async function readKimiWebConfig(
  baseUrl: string,
  bridgeToken: string,
  fetcher?: typeof fetch,
): Promise<KimiWebProviderConfigWire> {
  const send = fetcher ?? fetch;
  const headers: Record<string, string> = {};
  if (bridgeToken) headers.Authorization = `Bearer ${bridgeToken}`;
  let response: Response;
  try {
    response = await send(`${baseUrl}${CONFIG_PATH}`, { method: 'GET', headers });
  } catch (cause) {
    throw new KimiWebTransportError(`Kimi Web request failed: GET ${CONFIG_PATH}`, {
      kind: 'network',
      path: CONFIG_PATH,
      cause,
    });
  }
  const text = await response.text().catch(() => '');
  if (response.status !== 200 || !text.trim()) {
    throw new KimiWebTransportError(
      `Kimi Web request failed (${response.status}) for ${CONFIG_PATH}.`,
      {
        kind: response.status === 200 ? 'malformed-response' : 'http-error',
        path: CONFIG_PATH,
        status: response.status,
      },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new KimiWebTransportError(`Kimi Web returned a non-JSON body for ${CONFIG_PATH}.`, {
      kind: 'malformed-response',
      path: CONFIG_PATH,
      cause,
    });
  }
  if (!isRecord(parsed) || typeof parsed.code !== 'number') {
    throw new KimiWebTransportError(`Kimi Web returned an invalid envelope for ${CONFIG_PATH}.`, {
      kind: 'malformed-response',
      path: CONFIG_PATH,
    });
  }
  if (parsed.code !== 0) {
    const msg = typeof parsed.msg === 'string' && parsed.msg ? parsed.msg : '';
    throw new KimiWebError(parsed.code, msg || `Kimi Web request failed (code ${parsed.code}).`);
  }
  return isRecord(parsed.data) ? (parsed.data as KimiWebProviderConfigWire) : {};
}

export function createKimiWebProvidersClient(options: {
  readonly bridgeUrl: string;
  readonly bridgeToken?: string;
  readonly fetcher?: typeof fetch;
}): KimiWebProvidersClient {
  const bridgeToken = options.bridgeToken?.trim() ?? '';
  const baseUrl = kimiWebProxyHttpUrl(kimiWebWsUrl(options.bridgeUrl, bridgeToken));
  const client = createKimiWebClient({
    baseUrl,
    getToken: () => bridgeToken,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
  return {
    ...client,
    getKimiWebConfig: () => readKimiWebConfig(baseUrl, bridgeToken, options.fetcher),
  };
}

function conflictProviderId(msg: string): string {
  const match = /^provider\s+(\S+)\s+already exists/iu.exec(msg.trim());
  return match?.[1] ?? '';
}

function toProvidersError(cause: unknown): KimiWebProvidersError {
  if (cause instanceof KimiWebError) {
    if (cause.code === CONFLICT_CODE) {
      return {
        kind: 'conflict',
        providerId: conflictProviderId(cause.msg),
        message: cause.msg,
        suggest: 'update',
      };
    }
    return { kind: 'business', message: cause.msg };
  }
  if (cause instanceof KimiWebTransportError) {
    return { kind: 'transport', message: cause.message };
  }
  return { kind: 'business', message: cause instanceof Error ? cause.message : String(cause) };
}

export type KimiWebProvidersOptions = {
  readonly client: KimiWebProvidersClient;
};

export function useKimiWebProviders(options: KimiWebProvidersOptions) {
  const { client } = options;

  const providers = ref<readonly KimiWebManagedProviderEntry[]>([]);
  const catalog = ref<readonly KimiWebProviderCatalogEntryWire[]>([]);
  const loading = ref(false);
  const error = ref<KimiWebProvidersError | null>(null);
  const busyProviderId = ref<string | null>(null);

  /**
   * Config model objects belong to this provider: qualified ids under its own
   * prefix, plus any listed qualified id that resolves elsewhere.
   */
  function modelDetailsFor(
    provider: KimiWebProviderWire,
    configModels: Record<string, KimiWebModelObjectWire>,
  ): KimiWebModelObjectWire[] {
    const prefix = `${provider.id}/`;
    const listed = new Set(provider.models);
    return Object.entries(configModels)
      .filter(([qualifiedId]) => qualifiedId.startsWith(prefix) || listed.has(qualifiedId))
      .map(([, model]) => model);
  }

  async function readModelDetails(): Promise<Record<string, KimiWebModelObjectWire>> {
    try {
      const config = await client.getKimiWebConfig();
      const models = config?.models;
      return isRecord(models) ? (models as Record<string, KimiWebModelObjectWire>) : {};
    } catch {
      // Detail enrichment is best-effort: a config failure degrades context
      // size and capabilities only, and never blanks the provider list.
      return {};
    }
  }

  async function fetchProviderState(): Promise<readonly KimiWebManagedProviderEntry[]> {
    const page = await client.listKimiWebProviders();
    const items = Array.isArray(page?.items) ? page.items : [];
    const configModels = await readModelDetails();
    const entries: KimiWebManagedProviderEntry[] = [];
    for (const item of items) {
      const details = modelDetailsFor(item, configModels);
      const source: KimiWebManagedProviderSource = {
        ...item,
        modelDetails: details,
        modelDetailsById: configModels,
      };
      const [mapped] = mapKimiWebProvidersToProviderInfo([source]);
      if (!mapped) continue;
      const models = mapped.models.map((model, index) => {
        const qualifiedId = item.models[index] ?? `${item.id}/${model.id}`;
        const object =
          configModels[qualifiedId] ??
          details.find(
            (candidate) => candidate.model === model.id || candidate.model === qualifiedId,
          );
        return object ? { ...model, qualifiedId, source: object } : { ...model, qualifiedId };
      });
      entries.push({ ...mapped, type: item.type, models });
    }
    return entries;
  }

  async function loadCatalog() {
    try {
      const page = await client.listKimiWebProviderCatalog();
      const items = Array.isArray(page?.items) ? page.items : [];
      catalog.value = items;
    } catch {
      // The catalog is auxiliary; its failure must not block the provider list.
      catalog.value = [];
    }
  }

  async function load(): Promise<boolean> {
    loading.value = true;
    error.value = null;
    let entries: readonly KimiWebManagedProviderEntry[];
    try {
      entries = await fetchProviderState();
    } catch (cause) {
      error.value = toProvidersError(cause);
      loading.value = false;
      return false;
    }
    providers.value = entries;
    await loadCatalog();
    loading.value = false;
    return true;
  }

  /** Reload after a successful write without surfacing a refresh error. */
  async function reloadQuietly(): Promise<boolean> {
    try {
      providers.value = await fetchProviderState();
      await loadCatalog();
      return true;
    } catch {
      return false;
    }
  }

  function toUpdateWire(input: KimiWebProviderUpdateRequest): KimiWebProviderUpdateInput {
    const apiKey =
      input.apiKey.kind === 'keep'
        ? undefined
        : input.apiKey.kind === 'remove'
          ? ''
          : input.apiKey.value;
    return {
      type: input.type,
      ...(input.base_url === undefined ? {} : { base_url: input.base_url }),
      ...(apiKey === undefined ? {} : { api_key: apiKey }),
      models: [...input.models],
    };
  }

  function providerIdForModel(modelId: string): string {
    const owner = providers.value.find((provider) => modelId.startsWith(`${provider.id}/`));
    return owner?.id ?? modelId.split('/')[0] ?? '';
  }

  async function createProvider(
    input: KimiWebProviderCreateInput,
  ): Promise<KimiWebProviderSaveResult> {
    busyProviderId.value = input.id;
    error.value = null;
    try {
      await client.createKimiWebProvider(input);
    } catch (cause) {
      error.value = toProvidersError(cause);
      busyProviderId.value = null;
      return { status: 'failed', error: error.value };
    }
    const refreshed = await reloadQuietly();
    busyProviderId.value = null;
    return refreshed ? { status: 'saved' } : { status: 'saved-refresh-failed' };
  }

  async function updateProvider(
    providerId: string,
    input: KimiWebProviderUpdateRequest,
  ): Promise<KimiWebProviderSaveResult> {
    busyProviderId.value = providerId;
    error.value = null;
    try {
      await client.updateKimiWebProvider(providerId, toUpdateWire(input));
    } catch (cause) {
      error.value = toProvidersError(cause);
      busyProviderId.value = null;
      return { status: 'failed', error: error.value };
    }
    const refreshed = await reloadQuietly();
    busyProviderId.value = null;
    return refreshed ? { status: 'saved' } : { status: 'saved-refresh-failed' };
  }

  async function deleteProvider(providerId: string): Promise<KimiWebProviderSaveResult> {
    busyProviderId.value = providerId;
    error.value = null;
    try {
      await client.deleteKimiWebProvider(providerId);
    } catch (cause) {
      error.value = toProvidersError(cause);
      busyProviderId.value = null;
      return { status: 'failed', error: error.value };
    }
    const refreshed = await reloadQuietly();
    busyProviderId.value = null;
    return refreshed ? { status: 'saved' } : { status: 'saved-refresh-failed' };
  }

  async function refreshProvider(providerId: string): Promise<KimiWebProviderSaveResult> {
    busyProviderId.value = providerId;
    error.value = null;
    try {
      await client.refreshKimiWebProvider(providerId);
    } catch (cause) {
      error.value = toProvidersError(cause);
      busyProviderId.value = null;
      return { status: 'failed', error: error.value };
    }
    const refreshed = await reloadQuietly();
    busyProviderId.value = null;
    return refreshed ? { status: 'saved' } : { status: 'saved-refresh-failed' };
  }

  async function refreshAll(): Promise<KimiWebProviderSaveResult> {
    busyProviderId.value = KIMI_WEB_ALL_PROVIDERS_BUSY_ID;
    error.value = null;
    try {
      await client.refreshAllKimiWebProviders();
    } catch (cause) {
      error.value = toProvidersError(cause);
      busyProviderId.value = null;
      return { status: 'failed', error: error.value };
    }
    const refreshed = await reloadQuietly();
    busyProviderId.value = null;
    return refreshed ? { status: 'saved' } : { status: 'saved-refresh-failed' };
  }

  async function importCatalog(): Promise<KimiWebProviderSaveResult> {
    busyProviderId.value = KIMI_WEB_ALL_PROVIDERS_BUSY_ID;
    error.value = null;
    try {
      await client.importKimiWebProviderCatalog();
    } catch (cause) {
      error.value = toProvidersError(cause);
      busyProviderId.value = null;
      return { status: 'failed', error: error.value };
    }
    const refreshed = await reloadQuietly();
    busyProviderId.value = null;
    return refreshed ? { status: 'saved' } : { status: 'saved-refresh-failed' };
  }

  async function setDefaultModel(modelId: string): Promise<boolean> {
    busyProviderId.value = providerIdForModel(modelId);
    error.value = null;
    try {
      await client.setKimiWebDefaultModel(modelId);
    } catch (cause) {
      error.value = toProvidersError(cause);
      busyProviderId.value = null;
      return false;
    }
    providers.value = providers.value.map((provider) =>
      provider.models.some((model) => model.qualifiedId === modelId)
        ? { ...provider, defaultModel: modelId }
        : provider,
    );
    busyProviderId.value = null;
    return true;
  }

  return {
    providers,
    catalog,
    loading,
    error,
    busyProviderId,
    load,
    createProvider,
    updateProvider,
    deleteProvider,
    refreshProvider,
    refreshAll,
    importCatalog,
    setDefaultModel,
  };
}
