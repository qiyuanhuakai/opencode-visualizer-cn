// RED harness for PR #182 finding 4: once the status panel decides a control is
// unsupported for the supplied harness scope, it must never call that adapter
// method, must clear whatever stale data the previous scope left behind, and
// must always show the source line — a coincidental adapter method returning
// data can never masquerade as an available control.
//
// The reproduction mounts the REAL StatusMonitorModal SFC under happy-dom with
// an explicit harnessScope whose manifest marks getMcpStatus unsupported, while
// the backend boundary still exposes a working getMcpStatus returning one
// entry — exactly the independent reviewer's round-081ff620a scenario.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type Ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from '../../shared/runtime/identity.js';
import { CORE_OPERATIONS, unsupported, validateHarnessManifest } from '../../shared/runtime/harnessContract.js';
import type { HarnessManifest, Support } from '../../shared/runtime/harnessContract.js';
import type { ControlScope } from '../composables/useRuntimeCapabilities';

const mcpStatus = vi.hoisted(() => vi.fn(async () => ({ 'fixture-server': { status: 'connected' } })));

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
vi.mock('../backends/registry', () => ({
  getPersistedCodexBridgeToken: () => '',
  getPersistedCodexBridgeUrl: () => 'ws://localhost:23004/codex',
  getActiveBackendAdapter: () => ({
    getGlobalHealth: async () => ({ healthy: true, version: '1.0.0' }),
    getGlobalConfig: async () => ({}),
    getLspStatus: async () => [],
    getSkillStatus: async () => [],
    getPluginStatus: async () => [],
    getMcpStatus: mcpStatus,
  }),
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
import en from '../locales/en';
import { useCodexApi } from '../composables/useCodexApi';

const ENVIRONMENT = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const INSTANCE = parseHarnessInstanceId('22222222-2222-4222-8222-222222222222');
const SCOPE: ControlScope = {
  kind: 'session',
  session: parseSessionRef({ environmentId: ENVIRONMENT, harnessInstanceId: INSTANCE, nativeSessionId: 'fixture-session' }),
};

/** A real contract-valid manifest whose MCP control carries the given support. */
function manifestWithMcpSupport(support: Support): HarnessManifest {
  return validateHarnessManifest({
    kind: 'opencode',
    environmentId: ENVIRONMENT,
    harnessInstanceId: INSTANCE,
    protocolVersion: 1,
    core: Object.fromEntries(Object.keys(CORE_OPERATIONS).map((name) => [name, { state: 'supported' }])),
    extensions: [{ name: 'getMcpStatus', owner: INSTANCE, scope: 'instance', permission: 'fixture:mcp', schemaVersion: 1, support }],
    capabilities: {},
  });
}

const MCP_SUPPORTED = manifestWithMcpSupport({ state: 'supported' });
const MCP_UNSUPPORTED = manifestWithMcpSupport(unsupported('MCP monitoring is not available for this harness instance'));

async function mountMonitor(manifests: Ref<HarnessManifest[]>) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp(defineComponent({
    setup() {
      return () => h(StatusMonitorModal, {
        open: true,
        preload: true,
        activeBackendKind: 'opencode',
        initialTab: 'mcp',
        codexApi: useCodexApi(),
        harnessScope: SCOPE,
        harnessManifests: manifests.value,
      });
    },
  }));
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.mount(root);
  await nextTick();
  await vi.waitFor(() => expect(root.querySelector('.status-monitor-body')).not.toBeNull());
  return { root, app };
}

const mcpContent = (root: HTMLElement) => root.querySelector('.status-monitor-content');
const sourceLine = (root: HTMLElement) => root.querySelector('[data-testid="monitor-control-source"]')?.textContent ?? '';

describe('StatusMonitorModal capability gating (PR #182 finding 4)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    mcpStatus.mockClear();
  });

  it('never calls an unsupported control and shows its source instead of the coincidental data', async () => {
    const { root, app } = await mountMonitor(ref([MCP_UNSUPPORTED]));
    await vi.waitFor(() =>
      expect(sourceLine(root).length > 0 || (root.textContent ?? '').includes('fixture-server')).toBe(true));

    expect(mcpStatus).not.toHaveBeenCalled();
    expect(root.textContent).not.toContain('fixture-server');
    expect(mcpContent(root)?.textContent).toContain('MCP monitoring is not available for this harness instance');
    app.unmount();
  });

  it('retires the previous scope results when the manifest changes under it', async () => {
    const manifests = ref<HarnessManifest[]>([MCP_SUPPORTED]);
    const { root, app } = await mountMonitor(manifests);
    await vi.waitFor(() => expect(root.textContent).toContain('fixture-server'));
    expect(mcpStatus).toHaveBeenCalledOnce();

    manifests.value = [MCP_UNSUPPORTED];
    await nextTick();
    await vi.waitFor(() => expect(sourceLine(root)).toContain('MCP monitoring is not available for this harness instance'));

    expect(root.textContent).not.toContain('fixture-server');
    expect(mcpStatus).toHaveBeenCalledOnce();
    app.unmount();
  });
});
