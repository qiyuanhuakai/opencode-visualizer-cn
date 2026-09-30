import { describe, expect, it, vi } from 'vitest';

import {
  createDshAdapter,
  DSH_MODEL_PROVIDER,
  type DshAdapterOptions,
} from './dshAdapter';
import {
  createDshModelSelectionController,
  DSH_MODEL_SELECTION_NONE,
  dshCompositeModelId,
  dshModelDisplayName,
  dshModelSurface,
  dshSelectModelRequest,
  isDshModelSelectionUsable,
  normalizeDshModelCatalog,
  parseDshCompositeModelId,
  readDshProjectionModelSelection,
  readDshSelectModelResponse,
} from './modelCatalog';
import { loadDshWireFixture } from './fixtures';
import type { DshRpcClient } from '../../utils/dshRpc';
import type { DshMuxClient } from '../../utils/dshMux';
import type { DshJsonValue } from './types';

const DSH_BRIDGE_URL = 'ws://localhost:23004/dsh/ws';

// Catalog shape anchored to docs/dsh.md §10 (live-verified): one provider,
// `deepseek-flash` / `deepseek-v4-pro`, reasoning ladder off/low/high/max.
const MODEL_CATALOG = {
  providers: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-flash',
          display_name: 'DeepSeek-V41-Flash',
          reasoningEfforts: ['off', 'low', 'high', 'max'],
          defaultReasoningEffort: 'high',
        },
        {
          id: 'deepseek-v4-pro',
          display_name: 'DeepSeek-V41-Pro',
          reasoningEfforts: ['off', 'low', 'high', 'max'],
          defaultReasoningEffort: 'high',
          maxContextTokens: 128000,
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Fakes (mirror the injectable surface pinned by dshAdapter.test.ts)
// ---------------------------------------------------------------------------

type RpcCall = { namespace: string; method: string; args: Record<string, unknown> };

function fakeRpcClient(responses: Record<string, unknown>) {
  const calls: RpcCall[] = [];
  const client = {
    call: vi.fn(async (namespace: string, method: string, args: Record<string, unknown> = {}) => {
      calls.push({ namespace, method, args });
      const response = responses[`${namespace}/${method}`];
      if (response === undefined) throw new Error(`unexpected dsh rpc ${namespace}/${method}`);
      if (response instanceof Error) throw response;
      return response as DshJsonValue;
    }),
    callMultipart: vi.fn(async () => ({ metadata: {}, bytes: [] })),
    nextRpcId: vi.fn(() => 'dsh-test-1'),
  } as unknown as DshRpcClient;
  return { client, calls };
}

function fakeMuxClient(frames: Record<string, unknown>) {
  const client = {
    connect: vi.fn(async () => undefined),
    open: vi.fn((endpoint: string) => ({
      streamId: `stream-${endpoint}`,
      promise: Promise.resolve(frames[endpoint] === undefined ? [] : [frames[endpoint]]),
      onItem: (listener: (value: unknown) => void) => {
        const value = frames[endpoint];
        if (value !== undefined) listener(value);
        return () => undefined;
      },
      cancel: () => undefined,
    })),
    cancel: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  } as unknown as DshMuxClient;
  return { client };
}

function adapterOptions(overrides: Partial<DshAdapterOptions> = {}): DshAdapterOptions {
  const rpc = fakeRpcClient({ 'session/modelCatalog': MODEL_CATALOG });
  return {
    bridgeUrl: DSH_BRIDGE_URL,
    rpcClient: rpc.client,
    muxClient: fakeMuxClient({}).client,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixture-driven: the captured session/follow snapshot carries a real
// projections.values.modelSelection.lastUsed (dsh@0.2.0-rc.2, 2026-09-29).
// ---------------------------------------------------------------------------

describe('readDshProjectionModelSelection (fixture)', () => {
  it('reads the current selection out of the real captured follow snapshot', () => {
    const fixture = loadDshWireFixture('wire-session-follow-snapshot.jsonl');
    const frame = fixture.frames[0] as unknown as { value: unknown };
    expect(readDshProjectionModelSelection(frame.value)).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
    });
  });
});

// ---------------------------------------------------------------------------
// Catalog -> shared model surface (same shape kimi's modelResponse produces).
// ---------------------------------------------------------------------------

describe('dshModelSurface', () => {
  it('normalizes the catalog into the shared BackendProviderResponse shape', () => {
    const surface = dshModelSurface(normalizeDshModelCatalog(MODEL_CATALOG));
    expect(surface.connected).toEqual([DSH_MODEL_PROVIDER]);
    expect(surface.all?.map((provider) => provider.id)).toEqual([DSH_MODEL_PROVIDER]);
    expect(Object.keys(surface.all?.[0]?.models ?? {})).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
    ]);
    expect(surface.all?.[0]?.models?.['deepseek-v4-pro']).toMatchObject({
      id: 'deepseek-v4-pro',
      name: 'DeepSeek-V41-Pro',
      providerID: 'deepseek-official',
      limit: { context: 128000 },
      capabilities: { reasoning: true, toolcall: true, attachment: false },
    });
    // The reasoning ladder becomes the model's variant map with the catalog default flagged.
    const variants = surface.all?.[0]?.models?.['deepseek-flash']?.variants as Record<
      string,
      { default: boolean }
    >;
    expect(Object.keys(variants)).toEqual(['off', 'low', 'high', 'max']);
    expect(variants.high.default).toBe(true);
    // Default selection is the first catalog model, and it is never a sentinel.
    expect(surface.default?.[DSH_MODEL_PROVIDER]).toBe('deepseek-flash');
    expect(JSON.stringify(surface)).not.toContain(DSH_MODEL_SELECTION_NONE);
  });

  it('rejects a catalog with no usable provider instead of fabricating one', () => {
    expect(() => normalizeDshModelCatalog({ providers: [] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Composite UI id <-> wire alias separation.
// ---------------------------------------------------------------------------

describe('dsh composite model id', () => {
  it('round-trips provider/model and the optional reasoning effort', () => {
    expect(dshCompositeModelId({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })).toBe(
      'deepseek-official/deepseek-v4-pro',
    );
    expect(
      dshCompositeModelId({
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'high',
      }),
    ).toBe('deepseek-official/deepseek-v4-pro:high');
    expect(parseDshCompositeModelId('deepseek-official/deepseek-v4-pro:high')).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    });
    expect(parseDshCompositeModelId('deepseek-official/deepseek-flash')).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    });
  });

  it('never turns a sentinel or malformed id into a model', () => {
    expect(parseDshCompositeModelId('')).toBeUndefined();
    expect(parseDshCompositeModelId('deepseek-v4-pro')).toBeUndefined();
    expect(parseDshCompositeModelId('/deepseek-v4-pro')).toBeUndefined();
    expect(parseDshCompositeModelId('deepseek-official/')).toBeUndefined();
    expect(parseDshCompositeModelId(`${DSH_MODEL_SELECTION_NONE}/${DSH_MODEL_SELECTION_NONE}`)).toBeUndefined();
    expect(dshCompositeModelId({ provider: DSH_MODEL_SELECTION_NONE, model: DSH_MODEL_SELECTION_NONE })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// selectModel wire payload.
// ---------------------------------------------------------------------------

describe('dshSelectModelRequest', () => {
  it('builds the session/selectModel args payload from a composite id', () => {
    expect(dshSelectModelRequest('session-1', 'deepseek-official/deepseek-v4-pro')).toEqual({
      sessionId: 'session-1',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    });
    expect(dshSelectModelRequest('session-1', 'deepseek-official/deepseek-v4-pro:max')).toEqual({
      sessionId: 'session-1',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    });
  });

  it('lets an explicit thought level win over the composite suffix', () => {
    expect(
      dshSelectModelRequest('session-1', 'deepseek-official/deepseek-v4-pro:max', 'low'),
    ).toMatchObject({ reasoningEffort: 'low' });
  });

  it('throws rather than sending a payload with no usable model', () => {
    expect(() => dshSelectModelRequest('session-1', '')).toThrow();
    expect(() =>
      dshSelectModelRequest('session-1', `${DSH_MODEL_SELECTION_NONE}/${DSH_MODEL_SELECTION_NONE}`),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// selectModel response + projection reads, with the __none__ guard.
// ---------------------------------------------------------------------------

describe('selection readers', () => {
  it('reads the {selected} envelope echoed by session/selectModel', () => {
    expect(
      readDshSelectModelResponse({
        selected: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
      }),
    ).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' });
  });

  it('reads projections from a snapshot, a mux item wrapper, and a session/get baseline', () => {
    const lastUsed = { provider: 'deepseek-official', model: 'deepseek-flash' };
    expect(
      readDshProjectionModelSelection({
        projections: { asOfSeq: 1, values: { modelSelection: { lastUsed, next: null } } },
      }),
    ).toEqual(lastUsed);
    expect(
      readDshProjectionModelSelection({
        value: { projections: { asOfSeq: 1, values: { modelSelection: { lastUsed, next: null } } } },
      }),
    ).toEqual(lastUsed);
    expect(
      readDshProjectionModelSelection({ values: { modelSelection: { lastUsed, next: null } } }),
    ).toEqual(lastUsed);
  });

  it('treats the clamp-off sentinel and missing selection as NO current model', () => {
    expect(isDshModelSelectionUsable({ provider: DSH_MODEL_SELECTION_NONE, model: DSH_MODEL_SELECTION_NONE })).toBe(false);
    expect(
      readDshProjectionModelSelection({
        projections: {
          asOfSeq: 1,
          values: {
            modelSelection: {
              lastUsed: { provider: DSH_MODEL_SELECTION_NONE, model: DSH_MODEL_SELECTION_NONE },
              next: null,
            },
          },
        },
      }),
    ).toBeUndefined();
    expect(
      readDshProjectionModelSelection({
        projections: {
          asOfSeq: 1,
          values: { modelSelection: { lastUsed: { provider: '', model: '' }, next: null } },
        },
      }),
    ).toBeUndefined();
    expect(readDshProjectionModelSelection({ projections: { asOfSeq: 1, values: {} } })).toBeUndefined();
    expect(readDshProjectionModelSelection(null)).toBeUndefined();
    expect(
      readDshSelectModelResponse({
        selected: { provider: DSH_MODEL_SELECTION_NONE, model: DSH_MODEL_SELECTION_NONE },
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Display name de-duplication.
// ---------------------------------------------------------------------------

describe('dshModelDisplayName', () => {
  it('drops a provider prefix so the label never repeats the provider', () => {
    expect(dshModelDisplayName('deepseek-official', 'deepseek-official/DeepSeek-V4-Pro')).toBe(
      'DeepSeek-V4-Pro',
    );
    expect(dshModelDisplayName('DeepSeek', 'DeepSeek-V41-Flash')).toBe('DeepSeek-V41-Flash');
    expect(dshModelDisplayName('deepseek-official', '')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Controller: select writes the wire, footprint updates, mount reads back from
// projections; neither `__none__` nor a stale echo ever becomes a fake model.
// ---------------------------------------------------------------------------

describe('createDshModelSelectionController', () => {
  it('writes session/selectModel and updates the footprint from the echoed selection', async () => {
    const selectModel = vi.fn(async () => ({
      selected: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
    }));
    const controller = createDshModelSelectionController({
      selectModel,
      getProjections: vi.fn(async () => ({})),
    });

    const selection = await controller.select('session-1', 'deepseek-official/deepseek-v4-pro:high');
    expect(selectModel).toHaveBeenCalledWith({
      sessionId: 'session-1',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    });
    expect(selection).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    });
    expect(controller.getState()).toEqual({ selection, known: true });
  });

  it('does not report success or move the footprint when the write fails', async () => {
    let fail = false;
    const controller = createDshModelSelectionController({
      selectModel: vi.fn(async () => {
        if (fail) throw new Error('boom');
        return { selected: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' } };
      }),
      getProjections: vi.fn(async () => ({})),
    });

    await controller.select('session-1', 'deepseek-official/deepseek-flash:high');
    const before = controller.getState();
    fail = true;
    await expect(
      controller.select('session-1', 'deepseek-official/deepseek-v4-pro:max'),
    ).rejects.toThrow('boom');
    expect(controller.getState()).toEqual(before);
  });

  it('mounts read-back from session/get projections and agrees with the write footprint', async () => {
    const projected = {
      projections: {
        asOfSeq: 3,
        values: {
          modelSelection: {
            lastUsed: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
            next: null,
          },
        },
      },
    };
    const controller = createDshModelSelectionController({
      selectModel: vi.fn(async () => ({
        selected: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
      })),
      getProjections: vi.fn(async () => projected),
    });

    // stale_state: the footprint after a select must equal the mount read-back.
    const written = await controller.select('session-1', 'deepseek-official/deepseek-v4-pro:high');
    const state = await controller.mountReadBack('session-1');
    expect(state.selection).toEqual(written);
  });

  it('lets the projection be authoritative over a divergent write echo', async () => {
    const controller = createDshModelSelectionController({
      selectModel: vi.fn(async () => ({
        selected: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
      })),
      getProjections: vi.fn(async () => ({
        projections: {
          asOfSeq: 3,
          values: {
            modelSelection: {
              lastUsed: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
              next: null,
            },
          },
        },
      })),
    });

    await controller.select('session-1', 'deepseek-official/deepseek-flash:high');
    const state = await controller.mountReadBack('session-1');
    expect(state.selection).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    });
  });

  it('exposes an explicit none state when the projection is __none__ or missing', async () => {
    for (const projections of [
      {
        projections: {
          asOfSeq: 1,
          values: {
            modelSelection: {
              lastUsed: { provider: DSH_MODEL_SELECTION_NONE, model: DSH_MODEL_SELECTION_NONE },
              next: null,
            },
          },
        },
      },
      { projections: { asOfSeq: 1, values: {} } },
    ]) {
      const controller = createDshModelSelectionController({
        selectModel: vi.fn(async () => ({})),
        getProjections: vi.fn(async () => projections),
      });
      const state = await controller.mountReadBack('session-1');
      expect(state).toEqual({ selection: null, known: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Consistency with the landed adapter surfaces (createSession's initial
// selection, listProviders, getGlobalConfig all derive from the same catalog).
// ---------------------------------------------------------------------------

describe('catalog <-> adapter consistency', () => {
  it('derives the same shared surface as the adapter listProviders/getGlobalConfig', async () => {
    const rpc = fakeRpcClient({ 'session/modelCatalog': MODEL_CATALOG });
    const adapter = createDshAdapter(adapterOptions({ rpcClient: rpc.client }));

    const catalog = normalizeDshModelCatalog(MODEL_CATALOG);
    expect(await adapter.listProviders()).toEqual(dshModelSurface(catalog));
    const config = await adapter.getGlobalConfig();
    expect(config.enabled_providers).toEqual(dshModelSurface(catalog).connected);
    expect(config.disabled_providers).toEqual([]);
  });

  it('matches the adapter createSession initial selection to the catalog surface default', async () => {
    const rpc = fakeRpcClient({
      'session/modelCatalog': MODEL_CATALOG,
      'session/create': { sessionId: 'session-new', agentPreset: 'standard' },
      'session/selectModel': {
        selected: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
      },
    });
    const mux = fakeMuxClient({
      'workspace/follow': {
        type: 'baseline',
        value: {
          items: [{ workspaceId: 'ws-1', path: '/tmp/dsh/repo', sessionIds: [] }],
          archivedSessionIds: [],
          pinnedSessionIds: [],
        },
      },
      'session/follow': {
        type: 'snapshot',
        header: { version: 4, id: 'session-new', cwd: '/tmp/dsh/repo' },
        cursor: 0,
        records: [],
        hasMore: false,
        projections: {
          asOfSeq: 0,
          values: {
            modelSelection: {
              lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
              next: null,
            },
          },
        },
      },
    });
    const adapter = createDshAdapter(
      adapterOptions({ rpcClient: rpc.client, muxClient: mux.client }),
    );

    const surface = dshModelSurface(normalizeDshModelCatalog(MODEL_CATALOG));
    const provider = surface.connected?.[0];
    const model = provider ? surface.default?.[provider] : undefined;
    const catalogModel = normalizeDshModelCatalog(MODEL_CATALOG)[0].models.find(
      (entry) => entry.id === model,
    );
    if (!provider || !model || !catalogModel) throw new Error('catalog surface incomplete');
    const composite = dshCompositeModelId({
      provider,
      model,
      reasoningEffort: catalogModel.defaultReasoningEffort,
    });
    if (!composite) throw new Error('composite id missing');

    await adapter.createSession('/tmp/dsh/repo');
    const selectCall = rpc.calls.find(
      (call) => call.namespace === 'session' && call.method === 'selectModel',
    );
    expect(selectCall?.args).toEqual({
      request: dshSelectModelRequest('session-new', composite),
    });
  });
});
