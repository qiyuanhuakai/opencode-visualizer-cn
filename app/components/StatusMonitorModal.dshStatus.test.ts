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
import type { DshStatusSnapshot } from './StatusMonitorModal.vue';
import { DSH_FALSE_CAPABILITY_KEYS } from '../backends/dsh/capabilities';
import en from '../locales/en';
import { useCodexApi } from '../composables/useCodexApi';

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
    expect(dshRowMeta(root, 'Capabilities')).toContain('projects');
    expect(dshRowMeta(root, 'Capabilities')).toContain('sessions');

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
    expect(capabilities).toContain('projects');
    expect(capabilities).toContain('sessions');
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
