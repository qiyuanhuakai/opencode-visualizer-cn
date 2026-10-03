/**
 * Runtime capability gating registry — RED-then-GREEN acceptance tests
 * (Todo 31).
 *
 * Contract under test:
 *   - a probe state machine with unknown / supported / unsupported / gated;
 *   - 404-class endpoints (agent-scoped, e.g. `skills/list`) classify
 *     `unknown`, never `unsupported` and never a false `supported`;
 *   - a rejected / malformed probe NEVER yields `supported`;
 *   - each probe owns an independent result slot (one failure cannot poison
 *     the registry);
 *   - the static `DSH_CAPABILITY_REGISTRY` is consumed as an all-unknown Scope
 *     OUT seed, never forked and never surfaced as supported without a probe;
 *   - a derived UI-gating view maps surfaces to their driving probe.
 *
 * Wire shapes below are copied from the recorded Task 6 probe results
 * (`.omo/evidence/dsh-web-adapt/task-6/probe-results.json`) and the Task 36
 * live frames — they are real shapes, not invented.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DSH_CAPABILITY_REGISTRY } from './capabilities';
import type { DshJsonValue } from './types';
import {
  DSH_AGENT_SCOPED_PROBES,
  DSH_CAPABILITY_PROBES,
  DSH_PROBE_KEYS,
  DSH_STATIC_CAPABILITY_PROBES,
  DSH_STATIC_CAPABILITY_SEED,
  DSH_SURFACE_DRIVER,
  classifyDshCapabilityError,
  createDshCapabilityRegistry,
  getActiveDshCapabilityRegistry,
  getDshCapabilityStates,
  isDshSurfaceAvailable,
  setActiveDshCapabilityRegistry,
  type DshCapabilityCall,
  type DshCapabilityState,
  type DshProbeContext,
  type DshProbeKey,
  type DshUiSurface,
} from './capabilityRegistry';
import {
  DshMissingCredentialError,
  DshRemoteRpcError,
  DshRpcForbiddenError,
  DshRpcNetworkError,
  DshRpcNotFoundError,
  DshRpcUnauthorizedError,
} from '../../utils/dshRpc';

// ---------------------------------------------------------------------------
// Real captured shapes (Task 6 probe results + Task 36 live frames)
// ---------------------------------------------------------------------------

const ACCOUNT_GET_STATE_VALUE: DshJsonValue = {
  status: 'signed-out',
  attempt: null,
  links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
};

const MODEL_CATALOG_VALUE: DshJsonValue = {
  default: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  routableProviders: ['deepseek-official'],
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-v4-pro',
          name: 'DeepSeek-V4-Pro',
          reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
        },
      ],
    },
  ],
  failures: [],
};

const TERMINAL_ENVIRONMENT_VALUE: DshJsonValue = {
  cwd: '/tmp',
  maxInputBytes: 65536,
  maxCols: 500,
  maxRows: 200,
  scrollback: 1000,
};

const WORKSPACE_FILES_LIST_VALUE: DshJsonValue = {
  path: '.',
  entries: [
    { name: 'README.md', type: 'file', size: 12 },
    { name: 'app', type: 'directory', size: 0 },
  ],
  truncated: false,
};

const FULL_CONTEXT: DshProbeContext = {
  agentId: 'session-934b411e-0113-4c5b-8719-2ea7ccf6ccf4',
  workspaceFileScopeId: 'session-934b411e-0113-4c5b-8719-2ea7ccf6ccf4',
  client: { version: '0.2.0-rc.2', locale: 'en-US', timezoneOffsetSeconds: 0 },
};

// ---------------------------------------------------------------------------
// Recorded-call mock (no vi.fn typing friction)
// ---------------------------------------------------------------------------

type Handler = (args: Record<string, DshJsonValue>) => DshJsonValue | Promise<DshJsonValue>;

function recordingCall(handlers: Record<string, Handler>) {
  const calls: Array<{ path: string; args: Record<string, DshJsonValue> }> = [];
  const call: DshCapabilityCall = async (namespace, method, args) => {
    const path = `${namespace}/${method}`;
    calls.push({ path, args });
    const handler = handlers[path];
    if (!handler) throw new Error(`unexpected probe call ${path}`);
    return handler(args);
  };
  return { call, calls };
}

function buildError(code: string, message: string): DshRemoteRpcError {
  return new DshRemoteRpcError({ code, message }, 'rpc-1', 'ns/method');
}

// ---------------------------------------------------------------------------
// Static seed: consumes the Scope OUT matrix, never forks it
// ---------------------------------------------------------------------------

describe('dsh runtime capability registry — static seed (Scope OUT)', () => {
  it('seeds every DSH_CAPABILITY_REGISTRY key as unknown (no fork, no static support)', () => {
    expect(Object.keys(DSH_STATIC_CAPABILITY_SEED).sort()).toEqual(
      Object.keys(DSH_CAPABILITY_REGISTRY).sort(),
    );
    for (const state of Object.values(DSH_STATIC_CAPABILITY_SEED)) {
      expect(state).toBe('unknown');
    }
    // A statically-true bit is NOT a runtime capability verdict.
    expect(DSH_CAPABILITY_REGISTRY.sessions).toBe(true);
    expect(DSH_STATIC_CAPABILITY_SEED.sessions).toBe('unknown');
  });

  it('maps only the runtime-probed static bits onto probe keys', () => {
    expect(DSH_STATIC_CAPABILITY_PROBES).toEqual({
      files: 'workspaceFiles',
      terminal: 'terminal',
      status: 'account',
    });
    for (const probe of Object.values(DSH_STATIC_CAPABILITY_PROBES)) {
      expect(DSH_PROBE_KEYS).toContain(probe as DshProbeKey);
    }
  });
});

// ---------------------------------------------------------------------------
// Probe descriptors (method paths pinned to docs/dsh.md §7)
// ---------------------------------------------------------------------------

describe('dsh runtime capability registry — probe descriptors', () => {
  it('covers every probe key exactly once with the documented method path', () => {
    expect(DSH_CAPABILITY_PROBES.map((probe) => probe.key).sort()).toEqual([...DSH_PROBE_KEYS].sort());
    const byKey = Object.fromEntries(DSH_CAPABILITY_PROBES.map((probe) => [probe.key, probe]));
    expect(byKey.account.method).toBe('getState');
    expect(byKey.account.namespace).toBe('account');
    expect(byKey.models.namespace).toBe('session');
    expect(byKey.models.method).toBe('modelCatalog');
    expect(byKey.terminal.namespace).toBe('terminal');
    expect(byKey.terminal.method).toBe('environment');
    expect(byKey.workspaceFiles.namespace).toBe('workspaceFiles');
    expect(byKey.workspaceFiles.method).toBe('list');
    expect(byKey.skills.namespace).toBe('skills');
    expect(byKey.skills.method).toBe('list');
    expect(byKey.profile.namespace).toBe('account');
    expect(byKey.profile.method).toBe('getProfile');
    expect(byKey.fileReferences.namespace).toBe('fileReferences');
    expect(byKey.fileReferences.method).toBe('list');
  });

  it('marks exactly the agent-scoped 404-class probes', () => {
    expect([...DSH_AGENT_SCOPED_PROBES].sort()).toEqual(['fileReferences', 'skills']);
    const byKey = Object.fromEntries(DSH_CAPABILITY_PROBES.map((probe) => [probe.key, probe]));
    for (const key of DSH_AGENT_SCOPED_PROBES) {
      expect(byKey[key].agentScoped).toBe(true);
    }
    expect(byKey.models.agentScoped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyCapabilityError (Codex precedent analog)
// ---------------------------------------------------------------------------

describe('classifyDshCapabilityError', () => {
  it('classifies an HTTP 404 as unknown (agent-scoped endpoint may legitimately not exist)', () => {
    expect(classifyDshCapabilityError(new DshRpcNotFoundError({ method: 'skills/list', rpcId: 'r' }))).toBe(
      'unknown',
    );
    expect(classifyDshCapabilityError({ status: 404, code: 'http-404' })).toBe('unknown');
  });

  it('classifies auth / permission fences as gated', () => {
    expect(classifyDshCapabilityError(new DshRpcUnauthorizedError({ method: 'x/y', rpcId: 'r' }))).toBe('gated');
    expect(classifyDshCapabilityError(new DshRpcForbiddenError({ method: 'x/y', rpcId: 'r' }))).toBe('gated');
    expect(
      classifyDshCapabilityError(
        new DshMissingCredentialError({ code: 'MISSING_CREDENTIAL', message: 'missing credential' }, 'r'),
      ),
    ).toBe('gated');
    expect(classifyDshCapabilityError(buildError('gateway/feature-disabled', 'capability is required'))).toBe('gated');
  });

  it('classifies a definitive structured negative as unsupported', () => {
    expect(
      classifyDshCapabilityError(buildError('terminal/unavailable', 'Terminal no longer exists in this Session')),
    ).toBe('unsupported');
    expect(
      classifyDshCapabilityError(buildError('gateway/internal', 'session search is not supported here')),
    ).toBe('unsupported');
  });

  it('classifies transport / unknown / malformed failures as unknown (never supported)', () => {
    expect(classifyDshCapabilityError(new DshRpcNetworkError('x/y', 'r', new Error('boom')))).toBe('unknown');
    expect(classifyDshCapabilityError(new Error('boom'))).toBe('unknown');
    expect(classifyDshCapabilityError(null)).toBe('unknown');
    expect(classifyDshCapabilityError(buildError('gateway/internal', 'unexpected internal error'))).toBe('unknown');
    for (const sample of [
      new DshRpcNetworkError('x/y', 'r', new Error('boom')),
      new Error('boom'),
      null,
      buildError('gateway/input-invalid', 'wire field "request" failed boundary validation'),
    ]) {
      expect(classifyDshCapabilityError(sample)).not.toBe('supported');
    }
  });
});

// ---------------------------------------------------------------------------
// Registry state machine
// ---------------------------------------------------------------------------

describe('createDshCapabilityRegistry — probe (Codex precedent)', () => {
  it('records supported on success and rethrows classified failures', async () => {
    const { call } = recordingCall({});
    const registry = createDshCapabilityRegistry({ call });

    await expect(registry.probe('models', async () => MODEL_CATALOG_VALUE)).resolves.toEqual(MODEL_CATALOG_VALUE);
    expect(registry.getState('models')).toBe('supported');

    const notFound = new DshRpcNotFoundError({ method: 'skills/list', rpcId: 'r' });
    await expect(registry.probe('skills', async () => { throw notFound; })).rejects.toBe(notFound);
    expect(registry.getState('skills')).toBe('unknown');

    const gated = new DshMissingCredentialError({ code: 'MISSING_CREDENTIAL', message: 'no credential' }, 'r');
    await expect(registry.probe('account', async () => { throw gated; })).rejects.toBe(gated);
    expect(registry.getState('account')).toBe('gated');
  });
});

describe('createDshCapabilityRegistry — probeAll independence', () => {
  it('keeps independent result slots when probes succeed, fail, 404, are gated or malformed', async () => {
    const notFound = () => new DshRpcNotFoundError({ method: 'skills/list', rpcId: 'r' });
    const gated = new DshMissingCredentialError({ code: 'MISSING_CREDENTIAL', message: 'no credential' }, 'r');
    const unavailable = buildError('terminal/unavailable', 'Terminal no longer exists in this Session');
    const { call } = recordingCall({
      'account/getState': () => ACCOUNT_GET_STATE_VALUE,
      'session/modelCatalog': () => { throw new DshRpcNetworkError('session/modelCatalog', 'r', new Error('down')); },
      'terminal/environment': () => { throw notFound(); },
      'workspaceFiles/list': () => ({ nope: true }), // malformed
      'skills/list': () => { throw notFound(); },
      'account/getProfile': () => { throw gated; },
      'fileReferences/list': () => { throw unavailable; },
    });
    const registry = createDshCapabilityRegistry({ call });

    const snapshot = await registry.refresh(FULL_CONTEXT);

    expect(snapshot.states).toMatchObject({
      account: 'supported',
      models: 'unknown',
      terminal: 'unknown',
      workspaceFiles: 'unknown',
      skills: 'unknown',
      profile: 'gated',
      fileReferences: 'unsupported',
    });
    // No thrown error escaped refresh().
    expect(registry.getState('account')).toBe('supported');
  });

  it('leaves context-dependent probes unknown and never calls them without context', async () => {
    const { call, calls } = recordingCall({
      'account/getState': () => ACCOUNT_GET_STATE_VALUE,
      'session/modelCatalog': () => MODEL_CATALOG_VALUE,
      'skills/list': () => ({}),
    });
    const registry = createDshCapabilityRegistry({ call });

    await registry.refresh({});

    expect(registry.getState('terminal')).toBe('unknown');
    expect(registry.getState('workspaceFiles')).toBe('unknown');
    expect(registry.getState('profile')).toBe('unknown');
    expect(registry.getState('fileReferences')).toBe('unknown');
    const paths = calls.map((entry) => entry.path);
    expect(paths).not.toContain('terminal/environment');
    expect(paths).not.toContain('workspaceFiles/list');
    expect(paths).not.toContain('account/getProfile');
    expect(paths).not.toContain('fileReferences/list');
    expect(registry.getState('models')).toBe('supported');
  });

  it('passes the context through to agent-scoped args', async () => {
    const { call, calls } = recordingCall({
      'terminal/environment': () => TERMINAL_ENVIRONMENT_VALUE,
      'workspaceFiles/list': () => WORKSPACE_FILES_LIST_VALUE,
    });
    const registry = createDshCapabilityRegistry({ call });
    await registry.probeAll(FULL_CONTEXT);

    const terminalCall = calls.find((entry) => entry.path === 'terminal/environment');
    expect(terminalCall?.args).toEqual({ agentId: FULL_CONTEXT.agentId });
    const filesCall = calls.find((entry) => entry.path === 'workspaceFiles/list');
    expect(filesCall?.args).toEqual({
      workspaceFileScopeId: FULL_CONTEXT.workspaceFileScopeId,
      path: '.',
    });
  });

  it('reports a malformed success as unknown, never supported and without crashing', async () => {
    const { call } = recordingCall({
      'session/modelCatalog': () => ({ default: 'not-an-object' }),
    });
    const registry = createDshCapabilityRegistry({ call });

    await expect(registry.refresh(FULL_CONTEXT)).resolves.toBeTruthy();
    expect(registry.getState('models')).toBe('unknown');
  });

  it('never yields supported from a rejected probe', async () => {
    const failures: unknown[] = [
      new DshRpcNotFoundError({ method: 'skills/list', rpcId: 'r' }),
      new DshRpcUnauthorizedError({ method: 'x/y', rpcId: 'r' }),
      new DshRpcNetworkError('x/y', 'r', new Error('boom')),
      buildError('gateway/input-invalid', 'bad wire'),
      new Error('plain'),
      'string-error',
    ];
    for (const failure of failures) {
      const { call } = recordingCall({
        'account/getState': () => { throw failure; },
      });
      const registry = createDshCapabilityRegistry({ call });
      await registry.refresh({});
      expect(registry.getState('account')).not.toBe('supported');
    }
  });
});

// ---------------------------------------------------------------------------
// Stale-state guard (reconnect / activation refresh)
// ---------------------------------------------------------------------------

describe('createDshCapabilityRegistry — stale state', () => {
  it('drops in-flight observations from a previous generation on invalidate', async () => {
    const { call } = recordingCall({});
    const registry = createDshCapabilityRegistry({ call });

    let release: ((value: DshJsonValue) => void) | undefined;
    const oldProbe = registry.probe('models', () => new Promise<DshJsonValue>((resolve) => { release = resolve; }));

    registry.invalidate('reconnect');
    await registry.probe('models', async () => MODEL_CATALOG_VALUE);
    release?.(MODEL_CATALOG_VALUE);
    await oldProbe;

    expect(registry.getState('models')).toBe('supported');
  });

  it('clears every slot back to unknown on invalidate and refresh', async () => {
    const { call } = recordingCall({ 'account/getState': () => ACCOUNT_GET_STATE_VALUE });
    const registry = createDshCapabilityRegistry({ call });

    await registry.refresh({});
    expect(registry.getState('account')).toBe('supported');

    registry.invalidate('connection-switch');
    expect(registry.getState('account')).toBe('unknown');

    await registry.refresh({});
    expect(registry.getState('account')).toBe('supported');
    registry.invalidate();
    for (const key of DSH_PROBE_KEYS) {
      expect(registry.getState(key)).toBe('unknown');
    }
  });
});

// ---------------------------------------------------------------------------
// Derived UI gating view
// ---------------------------------------------------------------------------

describe('createDshCapabilityRegistry — UI gating view', () => {
  it('drives each surface from exactly one probe key', () => {
    const surfaces: DshUiSurface[] = ['account', 'models', 'fileTree', 'shell', 'skills', 'profile'];
    expect(Object.keys(DSH_SURFACE_DRIVER).sort()).toEqual([...surfaces].sort());
    for (const driver of Object.values(DSH_SURFACE_DRIVER)) {
      expect(DSH_PROBE_KEYS).toContain(driver);
    }
    expect(DSH_SURFACE_DRIVER).toEqual({
      account: 'account',
      models: 'models',
      fileTree: 'workspaceFiles',
      shell: 'terminal',
      skills: 'skills',
      profile: 'profile',
    });
  });

  it('hides a surface until its probe is proven supported', async () => {
    const { call } = recordingCall({});
    const registry = createDshCapabilityRegistry({ call });

    expect(registry.isSurfaceAvailable('models')).toBe(false);
    expect(registry.getSurfaceState('models')).toBe('unknown');

    registry.markSupported('models');
    expect(registry.isSurfaceAvailable('models')).toBe(true);
    expect(registry.getSurfaceState('models')).toBe('supported');

    registry.markSupported('terminal');
    expect(registry.isSurfaceAvailable('shell')).toBe(true);
    expect(registry.isSurfaceAvailable('fileTree')).toBe(false);

    // A gated probe must not unlock its surface.
    registry.markGated('terminal');
    expect(registry.isSurfaceAvailable('shell')).toBe(false);
  });

  it('exposes a snapshot with states and surfaces for consumers', async () => {
    const { call } = recordingCall({
      'account/getState': () => ACCOUNT_GET_STATE_VALUE,
    });
    const registry = createDshCapabilityRegistry({ call });
    const snapshot = await registry.refresh({});

    expect(snapshot.generation).toBe(registry.snapshot().generation);
    expect(snapshot.states.account).toBe('supported');
    expect(snapshot.surfaces.account).toBe(true);
    expect(snapshot.surfaces.models).toBe(false);
  });

  it('exposes getDshCapabilityStates/getState shapes', async () => {
    const { call } = recordingCall({ 'account/getState': () => ACCOUNT_GET_STATE_VALUE });
    const registry = createDshCapabilityRegistry({ call });
    await registry.refresh({});

    const states = registry.getStates();
    expect(Object.keys(states).sort()).toEqual([...DSH_PROBE_KEYS].sort());
    expect(states.account).toBe('supported');
    expect(states.models).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Module-level consumer seam (Todo 33/34)
// ---------------------------------------------------------------------------

describe('dsh runtime capability registry — module consumer seam', () => {
  beforeEach(() => {
    setActiveDshCapabilityRegistry(null);
  });

  it('returns an all-unknown seed when no registry is active', () => {
    expect(getActiveDshCapabilityRegistry()).toBeNull();
    const states = getDshCapabilityStates();
    for (const key of DSH_PROBE_KEYS) {
      expect(states[key]).toBe('unknown');
    }
    expect(isDshSurfaceAvailable('models')).toBe(false);
  });

  it('reflects the active registry once set and resets on clear', async () => {
    const { call } = recordingCall({ 'session/modelCatalog': () => MODEL_CATALOG_VALUE });
    const registry = createDshCapabilityRegistry({ call });
    setActiveDshCapabilityRegistry(registry);

    expect(getActiveDshCapabilityRegistry()).toBe(registry);
    expect(isDshSurfaceAvailable('models')).toBe(false);

    await registry.refresh({});
    expect(getDshCapabilityStates().models).toBe('supported');
    expect(isDshSurfaceAvailable('models')).toBe(true);

    setActiveDshCapabilityRegistry(null);
    expect(getDshCapabilityStates().models).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Type-level exhaustiveness (compile-time contract)
// ---------------------------------------------------------------------------

describe('dsh capability state union', () => {
  it('is exactly unknown | supported | unsupported | gated', () => {
    const states: DshCapabilityState[] = ['unknown', 'supported', 'unsupported', 'gated'];
    expect(new Set(states).size).toBe(4);
  });
});

 it('accepts installed plugin and session skill schemas with the actual RPC arguments', async () => {
  const { call, calls } = recordingCall({
    'skills/list': () => ({ skills: [{ name: 'review', description: 'Review', modelInvocable: true }] }),
    'pluginManager/listPlugins': () => [{ entryId: 'plugin', moduleName: 'dsh-mcp-resources', enabled: true }],
  });
  const registry = createDshCapabilityRegistry({ call });
  const result = await registry.refresh(FULL_CONTEXT);
  expect(result.states).toMatchObject({ skills: 'supported', plugins: 'supported' });
  expect(calls.find((entry) => entry.path === 'skills/list')?.args).toEqual({ request: { sessionId: FULL_CONTEXT.agentId } });
});
