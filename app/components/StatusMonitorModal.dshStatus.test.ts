import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, reactive, ref } from 'vue';
import { createI18n } from 'vue-i18n';

/**
 * Todo 34 — dsh branches of the Status Monitor.
 *
 * The dsh section renders the state bits the landed dsh surface ACTUALLY
 * exposes, each traceable to a real source module:
 *
 *   - connection state   → useBackendActivation.ts:13 ConnectionState
 *   - session busy       → useDshMessageBridge mergeSession({busy}) /
 *                          dshMessageBridgeTypes.ts:158 DshBridgeSessionState.busy
 *   - follow-stream health → dshSyncStateMachine.ts:34 DshSyncPhase +
 *                          dshMessageBridgeTypes.ts:142 DshSyncState
 *   - pending approvals  → useDshMessageBridge.ts:845 pendingApprovals /
 *                          dshMessageBridgeTypes.ts:118 DshApprovalRequest
 *   - permission preset / sandbox / approval policy → dshPermissions.ts:161
 *                          DshPermissionPresetState
 *   - model selection    → modelCatalog.ts DshModelSelection
 *   - capability matrix  → capabilities.ts:37 DSH_CAPABILITY_REGISTRY (true keys)
 *                          + DSH_FALSE_CAPABILITY_KEYS (negative set)
 *
 * Adversarial guards pinned here:
 *   - misleading_success_output: an unknown/fake state value never renders a
 *     success-like label, and the row count equals exactly the provided state
 *     bits (zero fabricated entries).
 *   - stale_state: transitions (ready→reconnecting, busy→idle, live→degraded)
 *     are reflected without a remount.
 *   - matrix gating: matrix-false capability names (worktrees/todos/questions)
 *     never appear; the dsh section is hidden for a non-dsh backend.
 */

const adapterMock = vi.hoisted(() => ({
  getAdapter: vi.fn<() => unknown>(() => dshAdapter()),
}));

function dshAdapter() {
  return {
    getGlobalHealth: async () => ({ healthy: true, version: '0.2.0-rc.2' }),
    getGlobalConfig: async () => ({}),
  };
}

function openCodeAdapter() {
  return {
    getGlobalHealth: async () => ({ healthy: true, version: '0.43.0' }),
    getMcpStatus: async () => ({}),
    getLspStatus: async () => [],
    getGlobalConfig: async () => ({}),
  };
}

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
vi.mock('../backends/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backends/registry')>();
  return { ...actual, getActiveBackendAdapter: () => adapterMock.getAdapter() };
});
vi.mock('../composables/useDesktopBridgeVersion', () => ({
  resolveDesktopBridgeHealthUrl: () => 'http://localhost:23004/healthz',
}));
vi.mock('../composables/useMessages', () => ({
  useMessages: () => ({
    roots: { value: [] },
    getThread: () => [],
    getUsage: () => undefined,
    loadHistory: () => undefined,
  }),
}));
vi.mock('../composables/useAcpBridge', () => ({
  useAcpBridge: () => ({
    services: { value: [] },
    agents: { value: [] },
    loading: { value: false },
    bridgeAvailable: { value: true },
    error: { value: '' },
    refresh: async () => undefined,
    updateAgent: async () => undefined,
    createAgent: async () => undefined,
    removeAgent: async () => undefined,
  }),
}));

import StatusMonitorModal from './StatusMonitorModal.vue';
import { mapDshUsageFrame, type DshStatusSnapshot } from './StatusMonitorModal.vue';
import { DSH_FALSE_CAPABILITY_KEYS } from '../backends/dsh/capabilities';
import {
  createDshCapabilityRegistry,
  setActiveDshCapabilityRegistry,
} from '../backends/dsh/capabilityRegistry';
import en from '../locales/en';
import { useCodexApi } from '../composables/useCodexApi';

function clickTab(root: HTMLElement, label: string) {
  const button = [...root.querySelectorAll<HTMLButtonElement>('[role="tablist"] button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  button?.click();
}

function dshTokenRowValue(root: HTMLElement, label: string): string | undefined {
  return [...root.querySelectorAll<HTMLElement>('.status-monitor-row.dsh-token-row')]
    .find((row) => row.querySelector('.token-label')?.textContent?.trim() === label)
    ?.querySelector('.token-value')
    ?.textContent?.trim();
}

function dshRow(root: HTMLElement, label: string): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>('.status-monitor-row.is-dsh')].find(
    (row) => row.querySelector('.status-monitor-name')?.textContent?.trim() === label,
  );
}

function dshRowMeta(root: HTMLElement, label: string): string | undefined {
  return dshRow(root, label)?.querySelector('.status-monitor-meta')?.textContent?.trim();
}

function dshRowDotClass(root: HTMLElement, label: string): string | undefined {
  return dshRow(root, label)?.querySelector('.status-dot')?.className;
}

async function mountDshModal(
  status: DshStatusSnapshot | undefined,
  activeBackendKind: 'dsh' | 'opencode' = 'dsh',
  initialTab?: 'plugins' | 'skills' | 'mcp',
) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const open = ref(false);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(StatusMonitorModal, {
            open: open.value,
            preload: false,
            activeBackendKind,
            initialTab,
            sessionId: 'selected-session',
            codexApi: useCodexApi(),
            ...(status === undefined ? {} : { dshStatus: status }),
          } as never);
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.mount(root);
  open.value = true;
  await nextTick();
  await vi.waitFor(() => expect(root.querySelector('.status-monitor-body')).not.toBeNull());
  return { root, app };
}

beforeEach(() => {
  adapterMock.getAdapter.mockReturnValue(dshAdapter());
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('StatusMonitorModal dsh status section', () => {
  it('renders every provided dsh state bit from its real source, with zero fabricated rows', async () => {
    const status = reactive<DshStatusSnapshot>({
      connectionState: 'ready',
      busy: true,
      followHealth: 'live',
      pendingApprovals: 2,
      permissions: {
        permissionPreset: 'workspace-write',
        sandboxMode: 'workspace',
        approvalPolicy: 'on-request',
      },
      model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
    });
    const { root, app } = await mountDshModal(status);
    await vi.waitFor(() => expect(dshRowMeta(root, 'Connection')).toBe('Ready'));

    expect(dshRowDotClass(root, 'Connection')).toContain('status-dot-success');
    expect(dshRowMeta(root, 'Session')).toBe('Busy');
    expect(dshRowMeta(root, 'Follow stream')).toBe('Live');
    expect(dshRowDotClass(root, 'Follow stream')).toContain('status-dot-success');
    expect(dshRowMeta(root, 'Pending approvals')).toBe('2');
    expect(dshRowMeta(root, 'Permission preset')).toBe('workspace-write');
    expect(dshRowMeta(root, 'Sandbox')).toBe('workspace');
    expect(dshRowMeta(root, 'Approval policy')).toBe('on-request');
    expect(dshRowMeta(root, 'Model')).toContain('deepseek/deepseek-chat');
    expect(dshRowMeta(root, 'Capabilities')).toContain('Projects');
    expect(dshRowMeta(root, 'Capabilities')).toContain('Sessions');

    // Exactly nine rows: no row exists for a state dsh does not expose.
    expect(root.querySelectorAll('.status-monitor-row.is-dsh')).toHaveLength(9);
    app.unmount();
  });

  it('hides every matrix-false capability from the rendered matrix', async () => {
    const { root, app } = await mountDshModal({});
    await vi.waitFor(() => expect(dshRowMeta(root, 'Capabilities')).toBeDefined());

    const capabilities = dshRowMeta(root, 'Capabilities') ?? '';
    for (const falseCapability of DSH_FALSE_CAPABILITY_KEYS) {
      expect(capabilities).not.toContain(falseCapability);
    }
    // True capability names are present, false ones are not.
    expect(capabilities).toContain('Projects');
    expect(capabilities).toContain('Sessions');
    // No rows were fabricated for the unsupported capability names.
    for (const label of ['Worktrees', 'Todos', 'Questions']) {
      expect(dshRow(root, label)).toBeUndefined();
    }
    app.unmount();
  });

  it('never renders a success-like label for an unknown/fake state value', async () => {
    const status = reactive({
      connectionState: 'teleporting',
      followHealth: 'ghost',
      busy: false,
    });
    const { root, app } = await mountDshModal(status as unknown as DshStatusSnapshot);
    await vi.waitFor(() => expect(dshRowMeta(root, 'Session')).toBe('Idle'));

    // The unknown enums produce no row at all — never a fabricated success.
    expect(dshRow(root, 'Connection')).toBeUndefined();
    expect(dshRow(root, 'Follow stream')).toBeUndefined();
    expect(root.textContent).not.toContain('Ready');
    expect(root.textContent).not.toContain('Live');
    expect(root.textContent).not.toContain('Rebuilding');
    app.unmount();
  });

  it('reflects status transitions without a remount (stale_state)', async () => {
    const status = reactive<DshStatusSnapshot>({
      connectionState: 'ready',
      busy: true,
      followHealth: 'live',
      pendingApprovals: 0,
    });
    const { root, app } = await mountDshModal(status);
    await vi.waitFor(() => expect(dshRowMeta(root, 'Connection')).toBe('Ready'));

    status.connectionState = 'reconnecting';
    status.busy = false;
    status.followHealth = 'degraded';
    status.pendingApprovals = 1;
    await vi.waitFor(() => expect(dshRowMeta(root, 'Connection')).toBe('Reconnecting'));

    expect(dshRowMeta(root, 'Session')).toBe('Idle');
    expect(dshRowMeta(root, 'Follow stream')).toBe('Degraded');
    expect(dshRowDotClass(root, 'Follow stream')).toContain('status-dot-error');
    expect(dshRowMeta(root, 'Pending approvals')).toBe('1');
    app.unmount();
  });

  it('does not render any dsh row when another backend is active', async () => {
    adapterMock.getAdapter.mockReturnValue(openCodeAdapter());
    const { root, app } = await mountDshModal(
      { connectionState: 'ready', busy: true, followHealth: 'live' },
      'opencode',
    );
    // Wait for the opencode refresh to land, then assert the dsh rows are absent.
    await vi.waitFor(() => expect(root.textContent).toContain('Healthy'));
    expect(root.querySelectorAll('.status-monitor-row.is-dsh')).toHaveLength(0);
    app.unmount();
  });

  it('renders no dsh row before the reader is wired (pre Todo 33 seam)', async () => {
    const { root, app } = await mountDshModal(undefined);
    await vi.waitFor(() => expect(root.textContent).toContain('Healthy'));
    expect(root.querySelectorAll('.status-monitor-row.is-dsh')).toHaveLength(0);
    app.unmount();
  });
});

describe('StatusMonitorModal dsh usage mapping', () => {
  it('maps a fixture-shaped usage frame + projections into the displayed token fields', async () => {
    const mapped = mapDshUsageFrame(
      {
        type: 'usage',
        usage: {
          uncachedInputTokens: 1200,
          outputTokens: 340,
          cacheReadTokens: 88,
          cacheWriteTokens: 12,
        },
      },
      {
        values: {
          modelSelection: {
            lastUsed: null,
            next: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
          },
        },
      },
      1_000_000,
    );
    expect(mapped).toEqual({
      uncachedInputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 88,
      cacheWriteTokens: 12,
      totalTokens: 1640,
      model: 'deepseek-official/deepseek-flash',
      contextWindow: 1_000_000,
      contextUsed: 1640,
    });

    const { root, app } = await mountDshModal({ usage: mapped });
    clickTab(root, 'Token');
    await vi.waitFor(() => expect(dshTokenRowValue(root, 'Input tokens')).toBe('1,200'));
    expect(dshTokenRowValue(root, 'Output tokens')).toBe('340');
    expect(dshTokenRowValue(root, 'Cache tokens (read/write)')).toBe('88 / 12');
    expect(dshTokenRowValue(root, 'Context limit')).toBe('1,000,000');
    expect(dshTokenRowValue(root, 'Model')).toBe('deepseek-official/deepseek-flash');
    app.unmount();
  });

  it('degrades a malformed usage frame without inventing numbers', () => {
    expect(
      mapDshUsageFrame({ type: 'usage', usage: { uncachedInputTokens: 'nope', outputTokens: -5 } }),
    ).toBeNull();
    expect(mapDshUsageFrame(null)).toBeNull();
    expect(mapDshUsageFrame({ type: 'usage', usage: {} })).toBeNull();
  });
});

describe('StatusMonitorModal dsh capability navigation', () => {
  it('opens an explicitly requested plugin tab and renders its runtime entries', async () => {
    adapterMock.getAdapter.mockReturnValue({
      ...dshAdapter(),
      getPluginStatus: async () => [{ id: 'mcp', name: 'dsh-mcp-resources', enabled: true, installed: true, accessible: true }],
    });
    const { root, app } = await mountDshModal({}, 'dsh', 'plugins');
    await vi.waitFor(() => expect(root.querySelector('.status-monitor-content')?.textContent).toContain('dsh-mcp-resources'));
    expect(root.querySelector('#status-monitor-tab-plugins')?.getAttribute('aria-selected')).toBe('true');
    app.unmount();
  });

  it('passes the selected session to the skill reader and renders its inventory', async () => {
    const getSkillStatus = vi.fn(async () => [{ name: 'review', path: '/skills/review' }]);
    adapterMock.getAdapter.mockReturnValue({ ...dshAdapter(), getSkillStatus });
    const { root, app } = await mountDshModal({ probes: { skills: 'supported' } }, 'dsh', 'skills');
    await vi.waitFor(() => expect(root.querySelector('.status-monitor-content')?.textContent).toContain('review'));
    expect(getSkillStatus).toHaveBeenCalledWith('selected-session');
    app.unmount();
  });

  it('retains unsupported and unknown status surfaces in navigation', async () => {
    const { root, app } = await mountDshModal({});
    expect([...root.querySelectorAll('[role="tab"]')].map((tab) => tab.id)).toEqual([
      'status-monitor-tab-server', 'status-monitor-tab-mcp', 'status-monitor-tab-lsp',
      'status-monitor-tab-plugins', 'status-monitor-tab-skills', 'status-monitor-tab-token', 'status-monitor-tab-acp',
    ]);
    app.unmount();
  });

  it('states the verified MCP monitoring and LSP interface limitations', async () => {
    const { root, app } = await mountDshModal({});
    clickTab(root, 'MCP');
    await vi.waitFor(() => expect(root.textContent).toContain('does not expose an MCP connection monitoring API'));
    expect(root.textContent).toContain('MCP servers are supported through plugins');
    clickTab(root, 'LSP');
    await vi.waitFor(() => expect(root.textContent).toContain('does not support an LSP language server API'));
    app.unmount();
  });

  it('keeps the selected skills tab when the runtime probe becomes unknown', async () => {
    const status = reactive<DshStatusSnapshot>({ probes: { skills: 'supported' } });
    const { root, app } = await mountDshModal(status);
    clickTab(root, 'Skills');
    await nextTick();
    expect(root.querySelector('#status-monitor-tab-skills')?.getAttribute('aria-selected')).toBe('true');
    status.probes = { skills: 'unknown' };
    await nextTick();
    expect(root.querySelector('#status-monitor-tab-skills')).not.toBeNull();
    expect(root.querySelector('#status-monitor-tab-skills')?.getAttribute('aria-selected')).toBe('true');
    app.unmount();
  });
});

describe('StatusMonitorModal dsh live version', () => {
  it('renders the supervisor-captured dsh version, never the hardcoded wire constant', async () => {
    const { root, app } = await mountDshModal({
      version: { value: '0.2.9', state: 'running', supported: true },
    });
    await vi.waitFor(() => expect(dshRowMeta(root, 'Version')).toBe('0.2.9'));
    // The generic server Version row (adapter `getGlobalHealth` → the pinned
    // wire constant) is suppressed for dsh, so the constant never leaks.
    expect(root.textContent).not.toContain('0.2.0-rc.2');
    app.unmount();
  });

  it('renders an error state for a version the supervisor gate rejected', async () => {
    const { root, app } = await mountDshModal({
      version: {
        value: '0.2.1',
        state: 'error',
        supported: false,
        error: 'protocol generation mismatch',
      },
    });
    await vi.waitFor(() => expect(dshRowMeta(root, 'Version')).toContain('0.2.1'));
    expect(dshRowDotClass(root, 'Version')).toContain('status-dot-error');
    expect(root.textContent).not.toContain('0.2.0-rc.2');
    app.unmount();
  });

  it('shows the version as unavailable when the supervised service is not running', async () => {
    const { root, app } = await mountDshModal({ version: { state: 'stopped', supported: false } });
    await vi.waitFor(() => expect(dshRowMeta(root, 'Version')).toBe('Service not running'));
    expect(dshRowDotClass(root, 'Version')).toContain('status-dot-muted');
    app.unmount();
  });
});

describe('StatusMonitorModal dsh connection switch', () => {
  it('keeps skills available after connection invalidation', async () => {
    const registry = createDshCapabilityRegistry({ call: async () => ({ ok: true }) });
    registry.markUnsupported('skills');
    setActiveDshCapabilityRegistry(registry);
    try {
      const { root, app } = await mountDshModal({});
      expect(root.querySelector('#status-monitor-tab-skills')).not.toBeNull();
      registry.invalidate('connection-switch');
      await nextTick();
      expect(root.querySelector('#status-monitor-tab-skills')).not.toBeNull();
      app.unmount();
    } finally {
      setActiveDshCapabilityRegistry(null);
    }
  });
});

describe('StatusMonitorModal dsh account', () => {
  it('shows the signed-out state and external sign-in guidance (no login flow)', async () => {
    const { root, app } = await mountDshModal({
      health: 'ok',
      account: {
        status: 'signed-out',
        usageUrl: 'https://platform.deepseek.com/usage',
        topUpUrl: 'https://platform.deepseek.com/top_up',
      },
    });
    await vi.waitFor(() => expect(dshRowMeta(root, 'Account')).toBe('Signed out'));
    expect(dshRowMeta(root, 'Account sign-in')).toContain('API-key');
    // Account sign-in is explicitly OUT of scope: no credential input renders.
    expect(root.querySelector('input[type="password"]')).toBeNull();
    app.unmount();
  });

  it('renders a gateway error when account/getState reports the gateway unreachable', async () => {
    const { root, app } = await mountDshModal({
      health: 'error',
      healthError: 'bridge refused the request',
    });
    await vi.waitFor(() => expect(dshRowMeta(root, 'Gateway health')).toBe('Unreachable'));
    expect(dshRowDotClass(root, 'Gateway health')).toContain('status-dot-error');
    app.unmount();
  });
});

describe('DSH session permission status', () => {
  it('keeps the monitor read-only while showing the current preset', async () => {
    const selectPermissionPreset = vi.fn(async () => undefined);
    adapterMock.getAdapter.mockReturnValue({ ...dshAdapter(), selectPermissionPreset,
      getPermissionPresetOptions: async () => [{ value: 'read-only', name: 'Read only' }, { value: 'workspace-write', name: 'Workspace' }],
    });
    const { root, app } = await mountDshModal({ permissions: { permissionPreset: 'workspace-write' } });
    await vi.waitFor(() => expect(dshRowMeta(root, 'Permission preset')).toBe('workspace-write'));
    expect(root.querySelector('[aria-label="Permission preset"]')).toBeNull();
    expect(selectPermissionPreset).not.toHaveBeenCalled();
    app.unmount();
  });
});
