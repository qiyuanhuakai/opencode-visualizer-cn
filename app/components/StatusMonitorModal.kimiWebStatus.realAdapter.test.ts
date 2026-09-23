import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';

/**
 * R5 (S4) — RED test for the kimi-web status monitor anomaly.
 *
 * Defect (measured, see `.omo/evidence/kimi-web-adapt/wave0/w0-p3-meta-ledger.md`):
 *   1. MCP/LSP/Skills/Plugins "unsupported" is derived from the STATIC
 *      `KIMI_WEB_CAPABILITIES` object, which carries no `mcp`/`lsp`/`skills`/
 *      `plugins` key — so all four always render the unsupported copy even
 *      though live `meta.capabilities.mcp === true`.
 *   2. The Server tab Version row shows the bridge `/healthz` version
 *      (`0.7.18`), not the kimi `server_version` (`0.43.0`), because the
 *      kimi-web refresh branch early-returns and never calls
 *      `KimiWebAdapter.getGlobalHealth()` (which returns `meta.server_version`).
 *   3. The kimi Capabilities / Models-ready rows are nested inside the
 *      `v-else` of `!serverHealth`, so a failed bridge-health fetch hides them.
 *
 * METHODOLOGY: unlike `StatusMonitorModal.kimiWebStatus.test.ts` — which mocks
 * `getActiveBackendAdapter` to THROW and asserts it is never called — this file
 * registers a REAL kimi adapter through `configureKimiWebBackend` +
 * `setActiveBackendKind('kimi-web')` and mounts the real component against it.
 * The registry module is NOT mocked, so `KIMI_WEB_CAPABILITIES` is the real
 * static object and the early-return branch is exercised for real.
 *
 * Orchestrator decisions (do not re-litigate):
 *   D3 — the Version row must show kimi `meta.server_version`.
 *   D4 — support is derived from live `meta.capabilities` ONLY where a key
 *        exists (today: `mcp`); `lsp`/`skills`/`plugins` stay on the static
 *        unsupported copy until a live key or a wired adapter method says
 *        otherwise.
 *
 * MOUNT SETUP (no @vue/test-utils; repo-established raw-createApp pattern):
 *   provides: none — `createI18n({legacy:false, locale:'en', messages:{en}})`
 *   mocks:    `@iconify/vue`, `../composables/useMessages`,
 *             `../composables/useSettings`, `../composables/useAcpBridge`
 *   NOT mocked: `../backends/registry` (real adapter registration),
 *               `../composables/useDesktopBridgeVersion` (real health URL)
 *   props:    `{open:true, preload:false, activeBackendKind:'kimi-web',
 *               sessionId, codexApi: useCodexApi(), kimiWebBridge: <stub>}`
 */

const SESSION_ID = 'session-1';
const BRIDGE_URL = 'ws://localhost:23004/kimi-web/ws';
const BRIDGE_TOKEN = 'bridge-tkn';

/** Bridge `/healthz` body (verbatim shape from `bridge/visBridgeServer.js`). */
const BRIDGE_HEALTH = { ok: true, service: 'vis_bridge', version: '0.7.18' };

/** Live `GET /kimi-web/api/v1/meta` envelope (verbatim from w0-p3-meta-ledger.md). */
const LIVE_META_ENVELOPE = {
  code: 0,
  msg: 'success',
  request_id: '01M3296MYACCS8F93P83B5M3JX',
  data: {
    server_version: '0.43.0',
    capabilities: {
      websocket: true,
      file_upload: true,
      fs_query: true,
      mcp: true,
      tasks: true,
      terminal: true,
    },
    server_id: '01M3296K3999YMBVGGYFTZMTZ9',
    started_at: '2026-09-21T15:26:22.825Z',
    open_in_apps: [],
    dangerous_bypass_auth: false,
    backend: 'v2',
    experimental_flags: {
      notify_user: false,
      subagent_fork: false,
      wait_for: true,
      tower: false,
      'tool-select': false,
    },
    features: [
      { name: 'skill', state: 'Active', meta: {} },
      { name: 'btw', state: 'Active', meta: {} },
      { name: 'dateChange', state: 'Active', meta: {} },
      { name: 'plan', state: 'Active', meta: {} },
      { name: 'fileHistory', state: 'Active', meta: {} },
      { name: 'externalHooks', state: 'Active', meta: {} },
      { name: 'debugEvents', state: 'Active', meta: {} },
      { name: 'swarm', state: 'Active', meta: {} },
      { name: 'goal', state: 'Active', meta: {} },
      { name: 'usage', state: 'Active', meta: {} },
      { name: 'cron', state: 'Active', meta: {} },
      { name: 'reminder', state: 'Active', meta: {} },
      { name: 'tokenCounting', state: 'Active', meta: {} },
      { name: 'sessionInit', state: 'Active', meta: {} },
      { name: 'todo', state: 'Active', meta: {} },
      { name: 'notify', state: 'Active', meta: {} },
    ],
  },
};

/** Live `GET /kimi-web/api/v1/auth` envelope. */
const LIVE_AUTH_ENVELOPE = {
  code: 0,
  msg: 'success',
  request_id: 'req-auth',
  data: {
    models_ready: true,
    providers_count: 1,
    managed_provider: { name: 'managed:kimi-code', status: 'authenticated' },
  },
};

/** Session status body (token-tab REST fallback source). */
const SESSION_STATUS = {
  code: 0,
  msg: 'success',
  request_id: 'req-status',
  data: {
    busy: false,
    model: 'kimi-code/kimi-for-coding',
    context_tokens: 20787,
    max_context_tokens: 1048576,
  },
};

const MCP_UNSUPPORTED_KIMI_WEB = 'Structured MCP status is not exposed by Kimi Web.';
const LSP_UNSUPPORTED_KIMI_WEB = 'Structured LSP status is not exposed by Kimi Web.';
const SKILLS_UNSUPPORTED_KIMI_WEB = 'Structured skill status is not exposed by Kimi Web.';
/** Shared "supported but nothing to list" copy — the honest post-fix MCP state. */
const MCP_NO_DATA = 'No MCP servers configured.';
const LIVE_CAPABILITIES_TEXT = 'websocket, file_upload, fs_query, mcp, tasks, terminal';
const BRIDGE_VERSION = '0.7.18';
const KIMI_SERVER_VERSION = '0.43.0';

type FakeResponse = {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
};

/** Per-test mutable: the rejected-health test flips this. */
let healthMode: 'ok' | 'reject' = 'ok';
/** Per-test mutable: lets a test re-shape the live meta (e.g. `mcp: false`). */
let metaData: Record<string, unknown> = LIVE_META_ENVELOPE.data as Record<string, unknown>;

const fetchMock = vi.fn<
  (input: unknown, init?: { headers?: Record<string, string> }) => Promise<FakeResponse>
>(async (input) => {
  const url = String(input);
  if (url.endsWith('/api/v1/plugins')) {
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { plugins: [
      { id: 'demo', displayName: 'Demo plugin', enabled: true, state: 'ok' },
    ] } }) };
  }
  if (url.endsWith('/api/v1/plugins/marketplace')) {
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { entries: [] } }) };
  }
  if (url.includes('/healthz')) {
    if (healthMode === 'reject') throw new Error('bridge health unreachable');
    return { ok: true, status: 200, json: async () => BRIDGE_HEALTH };
  }
  if (url.endsWith('/api/v1/meta')) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ...LIVE_META_ENVELOPE, data: metaData }),
    };
  }
  if (url.endsWith('/api/v1/auth')) {
    return { ok: true, status: 200, text: async () => JSON.stringify(LIVE_AUTH_ENVELOPE) };
  }
  if (url.endsWith('/status')) {
    return { ok: true, status: 200, text: async () => JSON.stringify(SESSION_STATUS) };
  }
  throw new Error(`unexpected fetch: ${url}`);
});

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
// NOTE: `../backends/registry` is deliberately NOT mocked — this file must
// exercise the real registry so `configureKimiWebBackend` /
// `setActiveBackendKind` / `getActiveBackendAdapter` and the real static
// `KIMI_WEB_CAPABILITIES` are the production ones.
// NOTE: `../composables/useDesktopBridgeVersion` is deliberately NOT mocked —
// the real `resolveDesktopBridgeHealthUrl` derives the bridge `/healthz` URL
// (`http://localhost:23004/healthz?token=bridge-tkn`) exactly like production.
vi.mock('../composables/useMessages', () => ({
  useMessages: () => ({
    roots: { value: [{ id: 'assistant-1', sessionID: 'session-1' }] },
    getThread: () => [
      { id: 'assistant-1', sessionID: 'session-1', role: 'assistant', time: { created: 1 } },
    ],
    getUsage: () => ({
      providerId: 'kimi-code',
      modelId: 'kimi-code/k3',
      tokens: { input: 0, output: 0, reasoning: 0 },
    }),
    loadHistory: () => undefined,
  }),
}));
vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({ showCodexInStatusMonitor: { value: false, __v_isRef: true } }),
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
import {
  configureKimiWebBackend,
  getActiveBackendAdapter,
  setActiveBackendKind,
} from '../backends/registry';
import type { KimiWebBridgeSessionState } from '../composables/kimiWebMessageBridgeTypes';
import { StorageKeys, storageKey } from '../utils/storageKeys';

/** Fresh page: no volatile `agent.status.updated` replay, so the REST fallback runs. */
function bridgeStub() {
  return {
    sessionState: (_sessionId: string): KimiWebBridgeSessionState | undefined => undefined,
  };
}

async function mountKimiWebModal() {
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
            activeBackendKind: 'kimi-web',
            sessionId: SESSION_ID,
            codexApi: useCodexApi(),
            kimiWebBridge: bridgeStub(),
          });
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.mount(root);
  open.value = true;
  await nextTick();
  return { root, app };
}

function clickTab(root: HTMLElement, label: string) {
  const button = [...root.querySelectorAll<HTMLButtonElement>('[role="tablist"] button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  button?.click();
}

function panel(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('#status-monitor-tabpanel');
}

/** The Server-tab row whose label is exactly `label` (e.g. 'Version'). */
function serverRow(root: HTMLElement, label: string): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>('.status-monitor-row')].find(
    (row) => row.querySelector('.status-monitor-name')?.textContent?.trim() === label,
  );
}

function rowValue(row: HTMLElement | undefined): string {
  return row?.querySelector('.status-monitor-meta')?.textContent?.trim() ?? '';
}

function hasRow(root: HTMLElement, label: string): boolean {
  return serverRow(root, label) !== undefined;
}

async function flushDom() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

/**
 * Waits until the component has actually issued the kimi REST calls, then
 * flushes microtasks/macrotasks so the settled values are in the DOM. Waiting
 * on the FETCHES (not on copy that only exists post-fix) keeps every RED
 * failure an assertion failure about missing/incorrect copy instead of a
 * timeout or a mount error.
 */
async function waitForKimiStatusFetches() {
  await vi.waitFor(() => {
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/v1/meta'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/v1/auth'))).toBe(true);
  });
  await flushDom();
}

beforeEach(() => {
  healthMode = 'ok';
  metaData = LIVE_META_ENVELOPE.data as Record<string, unknown>;
  localStorage.setItem(storageKey(StorageKeys.auth.kimiWebBridgeUrl), BRIDGE_URL);
  localStorage.setItem(storageKey(StorageKeys.auth.kimiWebBridgeToken), BRIDGE_TOKEN);
  // Stub fetch BEFORE configuring the adapter: the adapter's REST client
  // captures the global `fetch` at construction time.
  vi.stubGlobal('fetch', fetchMock);
  configureKimiWebBackend({ bridgeUrl: BRIDGE_URL, bridgeToken: BRIDGE_TOKEN });
  setActiveBackendKind('kimi-web');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('R5 real kimi-web adapter registration', () => {
  it('registers a real kimi-web adapter (not the throwing placeholder stub)', async () => {
    // The old test file mocks `getActiveBackendAdapter` to throw; this file
    // must prove the production registration path is live.
    let adapter: ReturnType<typeof getActiveBackendAdapter> | undefined;
    expect(() => {
      adapter = getActiveBackendAdapter();
    }).not.toThrow();
    if (!adapter) throw new Error('kimi-web adapter must be registered');
    expect(adapter.kind).toBe('kimi-web');

    // `KimiWebAdapter.getGlobalHealth()` is the D3 source of truth: it must
    // answer from live `meta.server_version`, never throw, and never report
    // the bridge version.
    const getGlobalHealth = adapter.getGlobalHealth;
    expect(typeof getGlobalHealth).toBe('function');
    if (typeof getGlobalHealth !== 'function') {
      throw new Error('kimi adapter must expose getGlobalHealth');
    }
    await expect(getGlobalHealth.call(adapter)).resolves.toEqual({
      healthy: true,
      version: KIMI_SERVER_VERSION,
    });

    // The kimi adapter exposes none of the structured status surfaces, so the
    // MCP tab must render "supported" without touching them (no crash).
    expect(typeof adapter?.getMcpStatus).toBe('undefined');
    expect(typeof adapter?.getLspStatus).toBe('undefined');
    expect(typeof adapter?.getSkillStatus).toBe('undefined');
    expect(typeof adapter?.getPluginStatus).toBe('undefined');
  });
});

describe('R5 (a) MCP tab must follow live meta.capabilities.mcp', () => {
  it('RED a1: MCP tab drops the unsupportedKimiWeb copy when live meta reports mcp:true', async () => {
    const { root, app } = await mountKimiWebModal();
    await waitForKimiStatusFetches();

    // Sanity: the live meta really reached the component (proves the fixture
    // is the live one and the tab switch is not hiding a fetch failure).
    expect(rowValue(serverRow(root, 'Capabilities'))).toBe(LIVE_CAPABILITIES_TEXT);

    clickTab(root, 'MCP');
    await flushDom();

    // RED — today this renders exactly the unsupported copy because
    // `kimiWebStatusSurfaceSupported('mcp')` reads the static capability
    // object, which has no `mcp` key.
    expect(panel(root)?.textContent).not.toContain(MCP_UNSUPPORTED_KIMI_WEB);
    app.unmount();
  });

  it('RED a2: MCP tab renders the supported-but-empty state (no crash, no error banner)', async () => {
    const { root, app } = await mountKimiWebModal();
    await waitForKimiStatusFetches();

    clickTab(root, 'MCP');
    await flushDom();

    const mcpPanel = panel(root);
    // RED — the honest post-fix presentation for "supported, adapter has no
    // getMcpStatus" is the shared empty-list state. Wave 2 may pick a
    // different-but-equivalent empty presentation; if so, update this
    // constant rather than weakening a1.
    expect(mcpPanel?.textContent).toContain(MCP_NO_DATA);
    // Showing MCP as supported must not crash and must not raise the generic
    // error banner (the adapter is really registered, `backend()` is live).
    expect(mcpPanel?.querySelector('.retry-button')).toBeNull();
    app.unmount();
  });

  it('GUARD: an unsupported MCP surface still shows the unsupportedKimiWeb copy', async () => {
    metaData = {
      ...(LIVE_META_ENVELOPE.data as Record<string, unknown>),
      capabilities: { websocket: true, mcp: false },
    };
    const { root, app } = await mountKimiWebModal();
    await waitForKimiStatusFetches();

    clickTab(root, 'MCP');
    await flushDom();

    // Green today (static object has no `mcp` key) and must stay green: a live
    // `mcp:false` must NOT be reported as supported.
    expect(panel(root)?.textContent).toContain(MCP_UNSUPPORTED_KIMI_WEB);
    app.unmount();
  });
});

describe('R5 (b) Server tab Version row must show the kimi server_version', () => {
  it('RED b1: Version row shows 0.43.0 (kimi meta.server_version)', async () => {
    const { root, app } = await mountKimiWebModal();
    await waitForKimiStatusFetches();

    const versionRow = serverRow(root, 'Version');
    expect(versionRow).toBeDefined();
    // RED — today the row renders `serverHealth.version`, i.e. the bridge
    // `/healthz` version, because the kimi branch never calls
    // `KimiWebAdapter.getGlobalHealth()`.
    expect(rowValue(versionRow)).toBe(KIMI_SERVER_VERSION);
    app.unmount();
  });

  it('RED b2: Version row does not leak the bridge /healthz version 0.7.18', async () => {
    const { root, app } = await mountKimiWebModal();
    await waitForKimiStatusFetches();

    const versionRow = serverRow(root, 'Version');
    expect(versionRow).toBeDefined();
    // RED — 0.7.18 is the vis_bridge version, never the kimi server version.
    expect(versionRow?.textContent).not.toContain(BRIDGE_VERSION);
    app.unmount();
  });
});

describe('R5 (c) Capabilities + Models ready survive a rejected /healthz', () => {
  it('RED c1: the Capabilities row still renders when the bridge health fetch rejects', async () => {
    healthMode = 'reject';
    const { root, app } = await mountKimiWebModal();
    await waitForKimiStatusFetches();

    // RED — today the row is swallowed by the `v-else` of `!serverHealth`, so
    // the whole panel degrades to "no server status information".
    expect(hasRow(root, 'Capabilities')).toBe(true);
    app.unmount();
  });

  it('RED c2: the Models ready row still renders when the bridge health fetch rejects', async () => {
    healthMode = 'reject';
    const { root, app } = await mountKimiWebModal();
    await waitForKimiStatusFetches();

    // RED — same `v-else` swallow as c1.
    expect(hasRow(root, 'Models ready')).toBe(true);
    app.unmount();
  });

  it('RED c3: both rows keep their live meta/auth values without bridge health', async () => {
    healthMode = 'reject';
    const { root, app } = await mountKimiWebModal();
    await waitForKimiStatusFetches();

    // RED — the row values come from live meta/auth, not from bridge health.
    expect(rowValue(serverRow(root, 'Capabilities'))).toBe(LIVE_CAPABILITIES_TEXT);
    expect(rowValue(serverRow(root, 'Models ready'))).toBe('Ready');
    app.unmount();
  });
});

describe('R5 (d) LSP / Skills keep the fail-closed unsupported copy', () => {
  it.each([
    ['LSP', LSP_UNSUPPORTED_KIMI_WEB],
    ['Skills', SKILLS_UNSUPPORTED_KIMI_WEB],
  ] as const)('GUARD: the %s tab keeps the unsupportedKimiWeb copy', async (label, message) => {
    const { root, app } = await mountKimiWebModal();
    await waitForKimiStatusFetches();

    clickTab(root, label);
    await flushDom();

    // Green today and MUST stay green after the fix (D4): no live capability
    // key and no wired adapter method exists for these surfaces, so the honest
    // fail-closed presentation is unchanged.
    expect(panel(root)?.textContent).toContain(message);
    app.unmount();
  });
});

describe('Kimi plugin management with a registered adapter', () => {
  it('loads installed plugins and exposes management controls in the Plugins tab', async () => {
    const { root, app } = await mountKimiWebModal();
    await waitForKimiStatusFetches();
    clickTab(root, 'Plugins');
    await flushDom();
    await vi.waitFor(() => expect(root.querySelector('[data-plugin-id="demo"]')).not.toBeNull());
    expect(root.querySelector('[data-plugin-id="demo"] [aria-pressed]')?.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('.kimi-plugins form')).not.toBeNull();
    app.unmount();
  });
});
