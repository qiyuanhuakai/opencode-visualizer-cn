// RED harness for task 23: native model/provider/auth/skills/MCP/usage controls
// must stay capability-gated per source, workspace controls must not depend on
// the active backend kind, and a save must capture the scope it belongs to.
//
// Every assertion below targets the task-4 mapping contract: an unsupported or
// unknown capability renders SOURCE INFORMATION (which source, what is
// missing/unsupported) and never masquerades as an available control.
import { describe, expect, it } from 'vitest';
import { CORE_OPERATIONS } from '../../shared/runtime/harnessContract.js';
import type { HarnessManifest, HarnessKind, Support } from '../../shared/runtime/harnessContract.js';
import { BACKEND_OPERATION_OWNERS, NATIVE_EXTENSIONS, WORKSPACE_OPERATIONS } from '../../shared/runtime/nativeExtensions.js';
import type { NativeOperation, WorkspaceOperation } from '../../shared/runtime/nativeExtensions.js';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from '../../shared/runtime/identity.js';
import type { EnvironmentId, HarnessInstanceId } from '../../shared/runtime/identity.js';
import {
  HARNESS_CONTROLS,
  WORKSPACE_CONTROLS,
  captureControlSave,
  describeControlSupport,
  resolveControlSupport,
  useRuntimeCapabilities,
} from './useRuntimeCapabilities';

const ENV_A = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const ENV_B = parseEnvironmentId('22222222-2222-4222-8222-222222222222');
const HARNESS_A = parseHarnessInstanceId('10000000-0000-4000-8000-000000000001');
const HARNESS_B = parseHarnessInstanceId('10000000-0000-4000-8000-000000000002');
const SESSION_A = parseSessionRef({ environmentId: ENV_A, harnessInstanceId: HARNESS_A, nativeSessionId: 'ses-a' });
const SESSION_B = parseSessionRef({ environmentId: ENV_B, harnessInstanceId: HARNESS_B, nativeSessionId: 'ses-b' });
const KINDS: readonly HarnessKind[] = ['opencode', 'codex', 'acp', 'kimi-web', 'dsh'];

const SUPPORTED: Support = Object.freeze({ state: 'supported' });
function unsupportedFor(reason: string): Support {
  return Object.freeze({ state: 'unsupported', code: 'unsupported', reason });
}

/** Build a manifest for one kind, declaring only `declared` native operations. */
function manifest(kind: HarnessKind, declared: readonly string[], options: Readonly<{
  environmentId?: EnvironmentId;
  harnessInstanceId?: HarnessInstanceId;
  capabilities?: Readonly<Record<string, Support>>;
}> = {}): HarnessManifest {
  const environmentId = options.environmentId ?? ENV_A;
  const harnessInstanceId = options.harnessInstanceId ?? HARNESS_A;
  const core = Object.freeze({
    inspect: SUPPORTED,
    listSessionPage: SUPPORTED,
    getSession: SUPPORTED,
    readHistoryPage: SUPPORTED,
    createSession: SUPPORTED,
    send: SUPPORTED,
    cancel: SUPPORTED,
    respondInteraction: SUPPORTED,
    subscribe: SUPPORTED,
    close: SUPPORTED,
  });
  const extensions = Object.freeze(declared.map((name) => Object.freeze({
    name,
    owner: harnessInstanceId,
    scope: NATIVE_EXTENSIONS[name as NativeOperation]?.scope ?? 'instance',
    permission: `${kind}:${name}`,
    schemaVersion: 1,
    support: SUPPORTED,
  })));
  return Object.freeze({ environmentId, harnessInstanceId, kind, protocolVersion: 1, core, extensions, capabilities: Object.freeze(options.capabilities ?? {}) });
}

/** The five harness kinds, each with a distinct declared native surface. */
const REGISTRY: Readonly<Record<HarnessKind, HarnessManifest>> = Object.freeze({
  // opencode: full provider/auth/skills/MCP surface, no usage monitor.
  opencode: manifest('opencode', ['listProviders', 'listProviderAuthMethods', 'setProviderAuth', 'authorizeProviderOAuth', 'completeProviderOAuth', 'deleteProviderAuth', 'getGlobalConfig', 'updateGlobalConfig', 'writeConfigValue', 'batchWriteConfig', 'getSessionConfigOptions', 'getMcpStatus', 'updateMcp', 'getSkillStatus', 'updateSkill', 'getLspStatus', 'getPluginStatus', 'getPluginManagementEntries', 'listAgents', 'listAgentAuthMethods', 'createAgentAuthPty', 'authenticateAgent', 'listCommands', 'getSessionStatusMap', 'listPendingPermissions', 'listPendingQuestions']),
  // codex: model + provider capability reads, no provider auth writes.
  codex: manifest('codex', ['listProviders', 'codex.models', 'codex.providerCapabilities', 'codex.usage', 'codex.rateLimits', 'codex.account', 'codex.requirements', 'getGlobalConfig', 'updateGlobalConfig', 'writeConfigValue', 'getMcpStatus', 'codex.mcp.reload', 'codex.mcp.oauth', 'codex.plugin.install', 'codex.plugin.uninstall', 'getSkillStatus', 'updateSkill', 'getPluginStatus']),
  // acp: agent configuration + MCP, no provider writes.
  acp: manifest('acp', ['listAgents', 'listAgentAuthMethods', 'createAgentAuthPty', 'authenticateAgent', 'getMcpStatus', 'updateMcp', 'getGlobalConfig', 'updateGlobalConfig', 'sendCommand', 'setPluginEnabled']),
  // kimi-web: usage monitor + skills, no provider auth.
  'kimi-web': manifest('kimi-web', ['getSkillStatus', 'updateSkill', 'getGlobalConfig', 'updateGlobalConfig']),
  // dsh: usage + provider config, no auth terminal.
  dsh: manifest('dsh', ['dsh.providers.list', 'dsh.models.list', 'dsh.models.select', 'dsh.plugins.list', 'dsh.agentPresets.list', 'dsh.permissions.catalog', 'getGlobalConfig', 'updateGlobalConfig', 'getMcpStatus', 'updateMcp']),
});

describe('task-23 criterion 1: native settings/provider/auth/skills/MCP/usage stay capability-gated', () => {
  it('every backend-specific control is registered in the task-4 mapping', () => {
    for (const [control, entry] of Object.entries(HARNESS_CONTROLS)) {
      const owner = BACKEND_OPERATION_OWNERS[control as keyof typeof BACKEND_OPERATION_OWNERS];
      if (owner) {
        expect(owner.owner, `control ${control} must be native or core, never workspace`).not.toBe('workspace');
        expect(owner.operation, `control ${control} must resolve its operation`).toBe(entry.operation);
      } else {
        expect(Object.hasOwn(WORKSPACE_OPERATIONS, entry.operation), `control ${control} must not shadow a workspace operation`).toBe(false);
        expect(Object.hasOwn(CORE_OPERATIONS, entry.operation), `control ${control} must not shadow a core operation`).toBe(false);
      }
    }
  });

  it('every backend-specific control resolves against at least one of the five kinds', () => {
    for (const [control] of Object.entries(HARNESS_CONTROLS)) {
      const supported = KINDS.some((kind) => resolveControlSupport({ control, scope: { kind: 'session', session: SESSION_A }, manifests: [REGISTRY[kind]] }).state === 'supported');
      expect(supported, `control ${control} must be declared by at least one harness`).toBe(true);
    }
  });

  it('a control whose operation is declared supported resolves as supported with its scope', () => {
    const support = resolveControlSupport({
      control: 'getLspStatus',
      scope: { kind: 'session', session: SESSION_A },
      manifests: [REGISTRY.opencode],
    });
    expect(support.state).toBe('supported');
    if (support.state !== 'supported' || support.channel !== 'harness') return;
    expect(support.operation).toBe('getLspStatus');
    expect(support.scope).toBe('instance');
    expect(support.capability).toBe('status');
  });

  it('an unsupported capability resolves unsupported with the source and its reason', () => {
    const declared = manifest('opencode', ['getMcpStatus'], {
      capabilities: { providerConfig: unsupportedFor('Codex owns provider configuration') },
    });
    const support = resolveControlSupport({
      control: 'updateGlobalConfig',
      scope: { kind: 'session', session: SESSION_A },
      manifests: [declared],
    });
    expect(support.state).toBe('unsupported');
    if (support.state !== 'unsupported') return;
    expect(support.reason).toBe('Codex owns provider configuration');
    expect(support.source).toEqual({ environmentId: ENV_A, harnessInstanceId: HARNESS_A, kind: 'opencode' });
    expect(describeControlSupport(support)).toContain('Codex owns provider configuration');
  });

  it('a capability no harness declares is unknown, carries the source, and is never available', () => {
    const support = resolveControlSupport({
      control: 'getMcpStatus',
      scope: { kind: 'session', session: SESSION_A },
      manifests: [REGISTRY['kimi-web']],
    });
    expect(support.state).toBe('unsupported');
    if (support.state !== 'unsupported') return;
    expect(support.reason).toMatch(/does not declare/i);
    expect(support.source).toEqual({ environmentId: ENV_A, harnessInstanceId: HARNESS_A, kind: 'kimi-web' });
  });

  it('an unknown control id is unsupported and never masquerades as available', () => {
    const support = resolveControlSupport({
      control: 'not-a-real-control',
      scope: { kind: 'session', session: SESSION_A },
      manifests: [REGISTRY.opencode],
    });
    expect(support.state).toBe('unsupported');
    if (support.state !== 'unsupported') return;
    expect(support.source).toBeNull();
    expect(support.reason).toMatch(/unknown/i);
  });

  it('every kind resolves its native controls against its own manifest, never another source', () => {
    for (const kind of KINDS) {
      const target = REGISTRY[kind];
      const core = target.core as Readonly<Record<string, Support | undefined>>;
      for (const [control, entry] of Object.entries(HARNESS_CONTROLS)) {
        const support = resolveControlSupport({ control, scope: { kind: 'session', session: SESSION_A }, manifests: [target] });
        const declared = Object.hasOwn(core, entry.operation) || target.extensions.some((extension) => extension.name === entry.operation);
        if (declared) expect(support.state, `${kind}/${control} should be supported`).toBe('supported');
        else {
          expect(support.state, `${kind}/${control} must be unsupported`).toBe('unsupported');
          if (support.state !== 'unsupported') continue;
          expect(support.source, `${kind}/${control} must carry the source`).toEqual({ environmentId: ENV_A, harnessInstanceId: HARNESS_A, kind });
        }
      }
    }
  });

  it('a control declared on another environment is not attributed to this one', () => {
    const foreign = manifest('opencode', ['getMcpStatus'], { environmentId: ENV_B, harnessInstanceId: HARNESS_B });
    const support = resolveControlSupport({ control: 'getMcpStatus', scope: { kind: 'session', session: SESSION_A }, manifests: [foreign] });
    expect(support.state).toBe('unsupported');
    if (support.state !== 'unsupported') return;
    expect(support.reason).toMatch(/not registered|another/i);
  });

  it('the ACP agent configuration controls stay gated on their own manifest', () => {
    const support = resolveControlSupport({
      control: 'authenticateAgent',
      scope: { kind: 'session', session: SESSION_A },
      manifests: [REGISTRY.acp],
    });
    expect(support.state).toBe('supported');
    expect(resolveControlSupport({ control: 'authenticateAgent', scope: { kind: 'session', session: SESSION_A }, manifests: [REGISTRY.codex] }).state).toBe('unsupported');
  });

  it('the codex model and usage controls are gated on the codex manifest', () => {
    expect(resolveControlSupport({ control: 'codex.models', scope: { kind: 'session', session: SESSION_A }, manifests: [REGISTRY.codex] }).state).toBe('supported');
    expect(resolveControlSupport({ control: 'codex.usage', scope: { kind: 'session', session: SESSION_A }, manifests: [REGISTRY.codex] }).state).toBe('supported');
    const elsewhere = resolveControlSupport({ control: 'codex.models', scope: { kind: 'session', session: SESSION_A }, manifests: [REGISTRY.opencode] });
    expect(elsewhere.state).toBe('unsupported');
  });

  it('the dsh usage surface is gated on the dsh manifest', () => {
    expect(resolveControlSupport({ control: 'getGlobalConfig', scope: { kind: 'session', session: SESSION_A }, manifests: [REGISTRY.dsh] }).state).toBe('supported');
    expect(resolveControlSupport({ control: 'getMcpStatus', scope: { kind: 'session', session: SESSION_A }, manifests: [REGISTRY.dsh] }).state).toBe('supported');
    expect(resolveControlSupport({ control: 'getSkillStatus', scope: { kind: 'session', session: SESSION_A }, manifests: [REGISTRY.dsh] }).state).toBe('unsupported');
  });
});

describe('task-23 criterion 2: workspace controls are independent of activeBackendKind', () => {
  it('every workspace control maps to a workspace operation in the task-4 mapping', () => {
    for (const [control, entry] of Object.entries(WORKSPACE_CONTROLS)) {
      const owner = BACKEND_OPERATION_OWNERS[entry.operation as keyof typeof BACKEND_OPERATION_OWNERS];
      expect(owner, `control ${control} must map to a task-4 operation`).toBeDefined();
      expect(owner.owner, `control ${control} must be workspace-owned`).toBe('workspace');
      expect(WORKSPACE_OPERATIONS[entry.operation as WorkspaceOperation]).toBe(entry.service);
    }
  });

  it('a workspace control resolves against the workspace scope regardless of the active backend kind', () => {
    const results = KINDS.map((activeBackendKind) => resolveControlSupport({
      control: 'listFiles',
      activeBackendKind,
      scope: { kind: 'workspace', environmentId: ENV_A, canonicalPath: '/repo' },
      manifests: [REGISTRY[activeBackendKind]],
    }));
    for (const result of results) {
      expect(result.state).toBe('supported');
      if (result.state !== 'supported' || result.channel !== 'workspace') continue;
      expect(result.service).toBe('files');
      expect(result.capability).toBe('files');
      expect(result.source).toEqual({ kind: 'workspace', environmentId: ENV_A, canonicalPath: '/repo' });
    }
    const [first, ...rest] = results;
    for (const result of rest) expect(result).toEqual(first);
  });

  it('a workspace control never reads the harness manifest and never reports a harness source', () => {
    const support = resolveControlSupport({
      control: 'createPty',
      activeBackendKind: 'codex',
      scope: { kind: 'workspace', environmentId: ENV_A, canonicalPath: '/repo' },
      manifests: [],
    });
    expect(support.state).toBe('supported');
    if (support.state !== 'supported') return;
    expect(support.source.kind).toBe('workspace');
    expect('harnessInstanceId' in support.source).toBe(false);
    expect(support.capability).toBe('terminal');
  });

  it('switching the active backend kind cannot flip a workspace control', () => {
    const capabilities = useRuntimeCapabilities({ activeBackendKind: KINDS[0]!, manifests: [REGISTRY[KINDS[0]!]] });
    const before = capabilities.support({ control: 'listFiles', scope: { kind: 'workspace', environmentId: ENV_A, canonicalPath: '/repo' } });
    for (const kind of KINDS.slice(1)) {
      capabilities.setActiveBackendKind(kind);
      const after = capabilities.support({ control: 'listFiles', scope: { kind: 'workspace', environmentId: ENV_A, canonicalPath: '/repo' } });
      expect(after).toEqual(before);
      expect(after.state).toBe('supported');
    }
  });

  it('a workspace control on an unknown workspace is unsupported with the workspace source', () => {
    const support = resolveControlSupport({
      control: 'listFiles',
      activeBackendKind: 'opencode',
      scope: { kind: 'workspace', environmentId: ENV_A, canonicalPath: '' },
      manifests: [REGISTRY.opencode],
    });
    expect(support.state).toBe('unsupported');
    if (support.state !== 'unsupported') return;
    expect(support.source).toEqual({ kind: 'workspace', environmentId: ENV_A, canonicalPath: '' });
  });

  it('a harness control on an unknown active backend kind stays unsupported with the source', () => {
    const support = resolveControlSupport({
      control: 'getMcpStatus',
      activeBackendKind: 'not-a-kind' as HarnessKind,
      scope: { kind: 'session', session: SESSION_A },
      manifests: [REGISTRY.opencode],
    });
    expect(support.state).toBe('unsupported');
    if (support.state !== 'unsupported') return;
    expect(support.source).toBeNull();
  });
});

describe('task-23 criterion 3: saving captures the scope', () => {
  it('a session-scoped save captures the qualified session', () => {
    const support = resolveControlSupport({
      control: 'updateMcp',
      scope: { kind: 'session', session: SESSION_A },
      manifests: [REGISTRY.opencode],
    });
    expect(support.state).toBe('supported');
    const save = captureControlSave({
      control: 'updateMcp',
      support,
      scope: { kind: 'session', session: SESSION_A },
      payload: { name: 'filesystem', enabled: false },
    });
    expect(save.scope).toEqual({ kind: 'session', session: SESSION_A });
    expect(save.payload).toEqual({ name: 'filesystem', enabled: false });
  });

  it('an instance-scoped save captures the explicit harness instance', () => {
    const support = resolveControlSupport({
      control: 'updateGlobalConfig',
      scope: { kind: 'instance', environmentId: ENV_A, harnessInstanceId: HARNESS_A },
      manifests: [REGISTRY.opencode],
    });
    expect(support.state).toBe('supported');
    const save = captureControlSave({
      control: 'updateGlobalConfig',
      support,
      scope: { kind: 'instance', environmentId: ENV_A, harnessInstanceId: HARNESS_A },
      payload: { disabled: ['openai'] },
    });
    expect(save.scope).toEqual({ kind: 'instance', environmentId: ENV_A, harnessInstanceId: HARNESS_A });
  });

  it('two sources with the same native id never share a save', () => {
    const supportA = resolveControlSupport({ control: 'updateMcp', scope: { kind: 'session', session: SESSION_A }, manifests: [manifest('opencode', ['getMcpStatus', 'updateMcp'], { environmentId: ENV_A, harnessInstanceId: HARNESS_A })] });
    const supportB = resolveControlSupport({ control: 'updateMcp', scope: { kind: 'session', session: SESSION_B }, manifests: [manifest('opencode', ['getMcpStatus', 'updateMcp'], { environmentId: ENV_B, harnessInstanceId: HARNESS_B })] });
    const saveA = captureControlSave({ control: 'updateMcp', support: supportA, scope: { kind: 'session', session: SESSION_A }, payload: { name: 'same', enabled: true } });
    const saveB = captureControlSave({ control: 'updateMcp', support: supportB, scope: { kind: 'session', session: SESSION_B }, payload: { name: 'same', enabled: true } });
    expect(saveA.scope).not.toEqual(saveB.scope);
    expect(saveA.capability).toBeNull();
    expect(saveB.capability).toBeNull();
  });

  it('an unsupported control cannot be saved', () => {
    const support = resolveControlSupport({ control: 'updateMcp', scope: { kind: 'session', session: SESSION_A }, manifests: [REGISTRY['kimi-web']] });
    expect(support.state).toBe('unsupported');
    expect(() => captureControlSave({ control: 'updateMcp', support, scope: { kind: 'session', session: SESSION_A }, payload: {} })).toThrow();
  });

  it('an unknown control cannot be saved', () => {
    const support = resolveControlSupport({ control: 'nope', scope: { kind: 'session', session: SESSION_A }, manifests: [REGISTRY.opencode] });
    expect(support.state).toBe('unsupported');
    expect(() => captureControlSave({ control: 'nope', support, scope: { kind: 'session', session: SESSION_A }, payload: {} })).toThrow();
  });

  it('a save captured for one source is rejected when applied to another', () => {
    const scopeA = { kind: 'session', session: SESSION_A } as const;
    const supportA = resolveControlSupport({ control: 'updateMcp', scope: scopeA, manifests: [manifest('opencode', ['getMcpStatus', 'updateMcp'], { environmentId: ENV_A, harnessInstanceId: HARNESS_A })] });
    const save = captureControlSave({ control: 'updateMcp', support: supportA, scope: scopeA, payload: { name: 'filesystem', enabled: false } });
    const capabilities = useRuntimeCapabilities({ activeBackendKind: 'opencode', manifests: [manifest('opencode', ['getMcpStatus', 'updateMcp'], { environmentId: ENV_A, harnessInstanceId: HARNESS_A })] });
    expect(capabilities.apply(save, scopeA)).toBe(true);
    expect(capabilities.apply(save, { kind: 'session', session: SESSION_B })).toBe(false);
    expect(() => capabilities.capture({ control: 'updateMcp', scope: { kind: 'session', session: SESSION_B }, payload: {} })).toThrow();
  });

  it('an instance save cannot be re-attributed to a session scope', () => {
    const instanceScope = { kind: 'instance', environmentId: ENV_A, harnessInstanceId: HARNESS_A } as const;
    const support = resolveControlSupport({ control: 'updateGlobalConfig', scope: instanceScope, manifests: [REGISTRY.opencode] });
    const save = captureControlSave({ control: 'updateGlobalConfig', support, scope: instanceScope, payload: { disabled: [] } });
    const capabilities = useRuntimeCapabilities({ activeBackendKind: 'opencode', manifests: [REGISTRY.opencode] });
    expect(capabilities.apply(save, { kind: 'session', session: SESSION_A })).toBe(false);
    expect(capabilities.apply(save, instanceScope)).toBe(true);
  });

  it('a save resolved on one source cannot be captured for another source', () => {
    const supportA = resolveControlSupport({ control: 'updateMcp', scope: { kind: 'session', session: SESSION_A }, manifests: [manifest('opencode', ['getMcpStatus', 'updateMcp'], { environmentId: ENV_A, harnessInstanceId: HARNESS_A })] });
    expect(() => captureControlSave({ control: 'updateMcp', support: supportA, scope: { kind: 'session', session: SESSION_B }, payload: {} })).toThrow();
  });

  it('a workspace save is captured against the workspace and never a harness', () => {
    const workspaceScope = { kind: 'workspace', environmentId: ENV_A, canonicalPath: '/repo' } as const;
    const support = resolveControlSupport({ control: 'runOneShotCommand', scope: workspaceScope, manifests: [REGISTRY.opencode] });
    const save = captureControlSave({ control: 'runOneShotCommand', support, scope: workspaceScope, payload: { command: 'ls' } });
    expect(save.scope).toEqual({ kind: 'workspace', environmentId: ENV_A, canonicalPath: '/repo' });
    expect(save.capability).toBe('terminal');
    const capabilities = useRuntimeCapabilities({ activeBackendKind: 'codex', manifests: [REGISTRY.codex] });
    expect(capabilities.apply(save, workspaceScope)).toBe(true);
    expect(capabilities.apply(save, { kind: 'session', session: SESSION_A })).toBe(false);
  });
});
