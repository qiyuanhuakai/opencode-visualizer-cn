import { computed } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import {
  KimiWebError,
  KimiWebTransportError,
  type KimiWebAuth,
  type KimiWebMeta,
} from '../../utils/kimiWeb';
import {
  KIMI_WEB_CAPABILITY_ACTIONS,
  KIMI_WEB_META_GATED_ACTIONS,
  KIMI_WEB_PROBE_ONLY_ACTIONS,
  classifyKimiWebCapabilityError,
  createKimiWebCapabilityRegistry,
  probeKimiWebSessionActions,
} from './capabilityRegistry';
import metaFixture from './fixtures/rest-meta.json';

// Real wire capture (docs evidence task-8.txt: `GET /api/v1/auth` live 0.43.0).
const MEASURED_AUTH: KimiWebAuth = {
  models_ready: true,
  providers_count: 1,
  managed_provider: { name: 'managed:kimi-code', status: 'authenticated' },
};

function measuredMeta(overrides: Partial<KimiWebMeta> = {}): KimiWebMeta {
  return { ...(metaFixture as { data: KimiWebMeta }).data, ...overrides };
}

function makeRegistry(
  overrides: Partial<{
    getMeta: () => Promise<KimiWebMeta>;
    getAuth: () => Promise<KimiWebAuth>;
  }> = {},
) {
  return createKimiWebCapabilityRegistry({
    getMeta: async () => measuredMeta(),
    getAuth: async () => MEASURED_AUTH,
    ...overrides,
  });
}

describe('Kimi Web runtime capability registry', () => {
  it('probes session actions without mutating a real session and gates unsupported routes', async () => {
    const registry = makeRegistry();
    await registry.refreshFirstLevel();
    const forkSession = vi.fn(async (id: string) => { throw new KimiWebError(40401, `session ${id} does not exist`); });
    const compactSession = vi.fn(async () => { throw new KimiWebError(40001, 'unsupported action'); });
    const undoSession = vi.fn(async (id: string) => { throw new KimiWebError(40401, `session ${id} does not exist`); });

    await probeKimiWebSessionActions(registry, { forkSession, compactSession, undoSession });

    expect(forkSession.mock.calls[0]?.[0]).toMatch(/^session_[0-9a-f-]{36}$/u);
    expect(registry.isAvailable('fork')).toBe(true);
    expect(registry.isAvailable('undo')).toBe(true);
    expect(registry.isAvailable('compact')).toBe(false);
  });

  it('starts fully unknown and hides every action (no UI before probing)', () => {
    const registry = makeRegistry();

    for (const action of KIMI_WEB_CAPABILITY_ACTIONS) {
      expect(registry.actionState(action)).toBe('unknown');
      expect(registry.isAvailable(action)).toBe(false);
    }
    expect(registry.firstLevel.value.probed).toBe(false);
    expect(registry.isConnectionReady()).toBe(false);
  });

  it('derives meta-gated actions from the live meta.capabilities flags', async () => {
    const registry = makeRegistry();
    await registry.refreshFirstLevel();

    for (const action of KIMI_WEB_META_GATED_ACTIONS) {
      expect(registry.actionState(action)).toBe('supported');
    }
    expect(registry.isConnectionReady()).toBe(true);

    const narrowed = makeRegistry({
      getMeta: async () =>
        measuredMeta({
          capabilities: { ...measuredMeta().capabilities, terminal: false, mcp: false },
        }),
    });
    await narrowed.refreshFirstLevel();
    expect(narrowed.actionState('terminal')).toBe('unsupported');
    expect(narrowed.actionState('mcp')).toBe('unsupported');
    expect(narrowed.actionState('tasks')).toBe('supported');
  });

  it('keeps probe-only actions unknown after a first-level refresh', async () => {
    const registry = makeRegistry();
    await registry.refreshFirstLevel();

    for (const action of KIMI_WEB_PROBE_ONLY_ACTIONS) {
      expect(registry.actionState(action)).toBe('unknown');
      expect(registry.isAvailable(action)).toBe(false);
    }
  });

  it('treats a meta document without a capabilities key as probe failure (fail-closed)', async () => {
    const registry = makeRegistry({
      getMeta: async () => measuredMeta({ capabilities: undefined as unknown as Record<string, boolean> }),
    });
    await registry.refreshFirstLevel();

    expect(registry.firstLevel.value.probed).toBe(false);
    expect(registry.isConnectionReady()).toBe(false);
    for (const action of KIMI_WEB_CAPABILITY_ACTIONS) {
      expect(registry.actionState(action)).toBe('unknown');
    }
  });

  it('treats a malformed auth response (no models_ready boolean) as probe failure', async () => {
    const registry = makeRegistry({ getAuth: async () => ({}) as unknown as KimiWebAuth });
    await registry.refreshFirstLevel();

    expect(registry.firstLevel.value.probed).toBe(false);
    expect(registry.actionState('tasks')).toBe('unknown');
  });

  it('gates the connection on auth.models_ready even when an action probed supported', async () => {
    const registry = makeRegistry({ getAuth: async () => ({ models_ready: false }) });
    await registry.refreshFirstLevel();

    expect(registry.actionState('tasks')).toBe('supported');
    expect(registry.isConnectionReady()).toBe(false);
    expect(registry.isAvailable('tasks')).toBe(false);
  });

  it('classifies probe results into supported/unsupported/gated/unknown', async () => {
    const registry = makeRegistry();
    await registry.refreshFirstLevel();

    await expect(registry.probe('fork', async () => ({ forked: true }))).resolves.toEqual({ forked: true });
    await expect(
      registry.probe('compact', async () => {
        throw new KimiWebError(40001, 'unknown action');
      }),
    ).rejects.toBeInstanceOf(KimiWebError);
    await expect(
      registry.probe('undo', async () => {
        throw new KimiWebError(40003, 'experimental feature disabled');
      }),
    ).rejects.toBeInstanceOf(KimiWebError);
    await expect(
      registry.probe('btw', async () => {
        throw new KimiWebTransportError('network down', { kind: 'network', path: '/api/v1/meta' });
      }),
    ).rejects.toBeInstanceOf(KimiWebTransportError);

    expect(registry.actionState('fork')).toBe('supported');
    expect(registry.actionState('compact')).toBe('unsupported');
    expect(registry.actionState('undo')).toBe('gated');
    expect(registry.actionState('btw')).toBe('unknown');
    expect(registry.isAvailable('fork')).toBe(true);
    expect(registry.isAvailable('undo')).toBe(false);
  });

  it('never counts a 200 envelope with code!=0 as a successful probe', async () => {
    const registry = makeRegistry();
    await registry.refreshFirstLevel();

    await expect(
      registry.probe('fork', async () => ({ code: 40001, msg: 'unknown action', data: null })),
    ).rejects.toBeInstanceOf(KimiWebError);

    expect(registry.actionState('fork')).not.toBe('supported');
    expect(registry.actionState('fork')).toBe('unsupported');
    expect(registry.isAvailable('fork')).toBe(false);
  });

  it('keeps an action hidden when its probe fails (fail-closed)', async () => {
    const registry = makeRegistry();
    await registry.refreshFirstLevel();

    const entryVisible = computed(() => registry.isAvailable('fork'));
    expect(entryVisible.value).toBe(false);

    await expect(
      registry.probe('fork', async () => {
        throw new KimiWebTransportError('bridge unreachable', {
          kind: 'network',
          path: '/api/v1/meta',
        });
      }),
    ).rejects.toBeInstanceOf(KimiWebTransportError);

    expect(registry.actionState('fork')).toBe('unknown');
    expect(entryVisible.value).toBe(false);
  });

  it('exposes experimental_flags for display but never uses them as a gate', async () => {
    const registry = makeRegistry({
      getMeta: async () =>
        measuredMeta({ experimental_flags: { subagent_fork: true, tower: false, wait_for: true } }),
    });
    await registry.refreshFirstLevel();

    expect(registry.firstLevel.value.experimentalFlags).toEqual({
      subagent_fork: true,
      tower: false,
      wait_for: true,
    });
    // A flag being on must not unlock a probe-only action.
    expect(registry.actionState('fork')).toBe('unknown');
    expect(registry.isAvailable('fork')).toBe(false);
  });

  it('drops probe observations from an invalidated connection generation', async () => {
    const registry = makeRegistry();
    await registry.refreshFirstLevel();

    let rejectOld: ((error: unknown) => void) | undefined;
    const oldRequest = registry.probe(
      'fork',
      () => new Promise<never>((_, reject) => (rejectOld = reject)),
    );

    registry.invalidate('model_catalog_changed');
    await expect(registry.probe('fork', async () => ({ forked: true }))).resolves.toEqual({ forked: true });
    rejectOld?.(new KimiWebError(40001, 'unknown action'));
    await oldRequest.catch(() => undefined);

    expect(registry.actionState('fork')).toBe('supported');
  });

  it('re-probes after a model-catalog change instead of serving stale capability state', async () => {
    let capabilities = measuredMeta().capabilities;
    const registry = createKimiWebCapabilityRegistry({
      getMeta: async () => measuredMeta({ capabilities }),
      getAuth: async () => MEASURED_AUTH,
    });

    await registry.refreshFirstLevel();
    expect(registry.actionState('tasks')).toBe('supported');

    registry.invalidate('model_catalog_changed');
    expect(registry.actionState('tasks')).toBe('unknown');
    expect(registry.isAvailable('tasks')).toBe(false);

    capabilities = { ...capabilities, tasks: false };
    await registry.refreshFirstLevel();
    expect(registry.actionState('tasks')).toBe('unsupported');
    expect(registry.isAvailable('tasks')).toBe(false);
    expect(registry.isConnectionReady()).toBe(true);
  });

  it('hides an unsupported action entry point reactively until a probe succeeds', async () => {
    const registry = makeRegistry();
    await registry.refreshFirstLevel();
    const forkEntryVisible = computed(() => registry.isAvailable('fork'));

    expect(forkEntryVisible.value).toBe(false);
    await registry.probe('fork', async () => ({ forked: true }));
    expect(forkEntryVisible.value).toBe(true);
    expect(registry.actionState('fork')).toBe('supported');
  });

  it('classifies transport errors and non-Kimi errors as unknown (never supported)', () => {
    expect(
      classifyKimiWebCapabilityError(
        new KimiWebTransportError('boom', { kind: 'malformed-response', path: '/api/v1/meta' }),
      ),
    ).toBe('unknown');
    expect(classifyKimiWebCapabilityError(new Error('boom'))).toBe('unknown');
    expect(classifyKimiWebCapabilityError(new KimiWebError(40001, 'unknown action'))).toBe('unsupported');
    expect(classifyKimiWebCapabilityError(new KimiWebError(40003, 'feature disabled'))).toBe('gated');
  });
});
