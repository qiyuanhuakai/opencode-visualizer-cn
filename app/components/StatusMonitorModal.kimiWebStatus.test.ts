import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';

/**
 * Todo 20 — kimi-web branches of the Status Monitor.
 *
 * Covers the two surfaces the plan assigns to this todo:
 *   1. the Token tab (context limit / input / output / reasoning / cache rows +
 *      usage progress bar) fed from the Todo 14 bridge session state, and
 *   2. the Server tab (adapter health via `meta.server_version` with the
 *      bridge `/healthz` fallback + `/api/v1/meta.capabilities` +
 *      `/api/v1/auth.models_ready`) plus the capability-gated unsupported copy
 *      on the LSP/Skills/Plugins tabs.
 *
 * The registry now registers a real kimi-web adapter, whose
 * `getGlobalHealth()` is the D3 version source. This file keeps
 * `getActiveBackendAdapter` mocked to THROW so the "no adapter registered"
 * fallback (bridge `/healthz` version) stays pinned; the adapter-wins path is
 * covered by `StatusMonitorModal.kimiWebStatus.realAdapter.test.ts`.
 */

const SESSION_ID = 'session-1';
const BRIDGE_URL = 'ws://localhost:23004/kimi-web/ws';
const BRIDGE_TOKEN = 'bridge-tkn';

const healthUrlMock = vi.hoisted(() =>
  vi.fn((_target: unknown) => 'http://localhost:23004/healthz?token=bridge-tkn'),
);
const adapterMock = vi.hoisted(() => ({
  getAdapter: vi.fn<() => unknown>(() => {
    throw new Error('Backend adapter is not registered: kimi-web');
  }),
}));

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
  resolveDesktopBridgeHealthUrl: (target: unknown) => healthUrlMock(target),
}));
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
import { kimiWebTokenUsageFromReport } from '../backends/kimiWeb/tokenUsage';
import type { KimiWebBridgeSessionState } from '../composables/kimiWebMessageBridgeTypes';
import type { KimiWebUsageReport } from '../backends/kimiWeb/wire';
import { StorageKeys, storageKey } from '../utils/storageKeys';

type FakeResponse = {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type KimiEnvelope = {
  code: number;
  msg: string;
  request_id: string;
  data: Record<string, unknown> | null;
};

/** Fresh per test: the failure-injection tests mutate these. */
function defaultKimiWire(): {
  health: { ok: boolean; service: string; version: string };
  meta: KimiEnvelope;
  auth: KimiEnvelope;
  status: KimiEnvelope | null;
} {
  return {
    health: { ok: true, service: 'vis_bridge', version: '0.43.0' },
    meta: {
      code: 0,
      msg: 'success',
      request_id: 'req-meta',
      data: {
        server_version: '0.43.0',
        server_id: 'srv-1',
        backend: 'v2',
        capabilities: {
          websocket: true,
          file_upload: true,
          fs_query: true,
          mcp: true,
          tasks: true,
          terminal: true,
        },
        dangerous_bypass_auth: false,
      } as Record<string, unknown>,
    },
    auth: {
      code: 0,
      msg: 'success',
      request_id: 'req-auth',
      data: { models_ready: true } as Record<string, unknown>,
    },
    status: {
      code: 0,
      msg: 'success',
      request_id: 'req-status',
      data: {
        busy: false,
        model: 'kimi-code/kimi-for-coding',
        context_tokens: 20787,
        max_context_tokens: 1048576,
      } as Record<string, unknown>,
    },
  };
}

let kimiWire: ReturnType<typeof defaultKimiWire> = defaultKimiWire();

const fetchMock = vi.fn<(input: unknown, init?: { headers?: Record<string, string> }) => Promise<FakeResponse>>(
  async (input) => {
    const url = String(input);
    if (url.includes('/healthz')) {
      return { ok: true, status: 200, json: async () => kimiWire.health };
    }
    if (url.endsWith('/api/v1/meta')) {
      return { ok: true, status: 200, text: async () => JSON.stringify(kimiWire.meta) };
    }
    if (url.endsWith('/api/v1/auth')) {
      return { ok: true, status: 200, text: async () => JSON.stringify(kimiWire.auth) };
    }
    if (url.endsWith('/status')) {
      if (!kimiWire.status) return { ok: false, status: 500 };
      return { ok: true, status: 200, text: async () => JSON.stringify(kimiWire.status) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  },
);

function clickTab(root: HTMLElement, label: string) {
  const button = [...root.querySelectorAll<HTMLButtonElement>('[role="tablist"] button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  button?.click();
}

function bridgeState(
  usage: KimiWebUsageReport | undefined,
  contextTokens: number,
  maxContextTokens: number,
): KimiWebBridgeSessionState {
  return {
    sessionId: SESSION_ID,
    sync: { kind: 'live', cursor: { seq: 7, epoch: 'ep-1' } },
    usage,
    contextTokens,
    maxContextTokens,
  };
}

function bridgeStub(state: KimiWebBridgeSessionState | undefined) {
  return {
    sessionState: (sessionId: string) => (sessionId === SESSION_ID ? state : undefined),
  };
}

async function mountKimiWebModal(options: {
  bridge?: { sessionState(sessionId: string): KimiWebBridgeSessionState | undefined };
  initialTab?: 'token' | 'server';
} = {}) {
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
            kimiWebBridge: options.bridge,
            ...(options.initialTab ? { initialTab: options.initialTab } : {}),
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

beforeEach(() => {
  kimiWire = defaultKimiWire();
  localStorage.setItem(storageKey(StorageKeys.auth.kimiWebBridgeUrl), BRIDGE_URL);
  localStorage.setItem(storageKey(StorageKeys.auth.kimiWebBridgeToken), BRIDGE_TOKEN);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('kimi-web token usage mapping (kimiWebTokenUsageFromReport)', () => {
  it('maps the kimi wire usage fields onto the shared MessageUsage shape', () => {
    const mapped = kimiWebTokenUsageFromReport(
      {
        total: { inputOther: 1200, output: 340, inputCacheRead: 800, inputCacheCreation: 200 },
        currentTurn: { inputOther: 10, output: 20 },
      },
      1280,
      2560,
    );
    expect(mapped).not.toBeNull();
    expect(mapped?.usage.tokens).toEqual({
      input: 1200,
      output: 340,
      reasoning: 0,
      total: 1200 + 340 + 800 + 200,
      cache: { read: 800, write: 200 },
    });
    expect(mapped?.contextUsed).toBe(1280);
    expect(mapped?.contextLimit).toBe(2560);
  });

  it('ignores currentTurn and byModel — only the cumulative total feeds the rows', () => {
    const mapped = kimiWebTokenUsageFromReport(
      { byModel: { a: { inputOther: 9999 } }, currentTurn: { inputOther: 9999 } },
      10,
      100,
    );
    expect(mapped).toBeNull();
  });

  it('treats missing or non-finite numbers as zero instead of NaN', () => {
    const mapped = kimiWebTokenUsageFromReport(
      {
        total: {
          inputOther: Number.NaN,
          output: undefined,
          inputCacheRead: 5,
          inputCacheCreation: Number.POSITIVE_INFINITY,
        },
      },
      Number.NaN,
      undefined,
    );
    expect(mapped?.usage.tokens).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      total: 5,
      cache: { read: 5, write: 0 },
    });
    expect(mapped?.contextUsed).toBe(0);
    expect(mapped?.contextLimit).toBe(0);
  });
});

describe('StatusMonitorModal kimi-web token tab', () => {
  it('renders the bridge usage on the token rows with the context progress bar', async () => {
    const bridge = bridgeStub(
      bridgeState({ total: { inputOther: 1200, output: 340, inputCacheRead: 800, inputCacheCreation: 200 } }, 1280, 2560),
    );
    const { root, app } = await mountKimiWebModal({ bridge });
    await vi.waitFor(() => expect(root.textContent).toContain('0.43.0'));

    clickTab(root, 'Token');
    await nextTick();
    await vi.waitFor(() => expect(root.textContent).toContain('1,200'));

    expect(root.textContent).toContain('kimi-code/k3');
    expect(root.textContent).toContain('2,560'); // context limit
    expect(root.textContent).toContain('340'); // output
    expect(root.textContent).toContain('800 / 200'); // cache read / write
    const fill = root.querySelector<HTMLElement>('.token-usage-fill');
    expect(fill?.style.width).toBe('50%'); // contextTokens / maxContextTokens
    expect(root.querySelector('.token-usage-percent')?.textContent).toBe('50%');
    app.unmount();
  });

  it('re-reads the bridge session state on refresh so mid-turn usage updates', async () => {
    const state: Mutable<KimiWebBridgeSessionState> = bridgeState(
      { total: { inputOther: 1200, output: 340, inputCacheRead: 0, inputCacheCreation: 0 } },
      1280,
      2560,
    );
    const { root, app } = await mountKimiWebModal({ bridge: bridgeStub(state) });
    await vi.waitFor(() => expect(root.textContent).toContain('0.43.0'));
    clickTab(root, 'Token');
    await nextTick();
    await vi.waitFor(() => expect(root.textContent).toContain('340'));

    // A later agent.status.updated lands in the bridge session state mid-turn.
    state.usage = { total: { inputOther: 1500, output: 999, inputCacheRead: 0, inputCacheCreation: 0 } };
    state.contextTokens = 2000;
    root.querySelector<HTMLButtonElement>('.refresh-button')?.click();
    await vi.waitFor(() => expect(root.textContent).toContain('999'));
    expect(root.querySelector('.token-usage-percent')?.textContent).toBe('78%');
    app.unmount();
  });

  it('shows no token data when the bridge has no session state and the status fetch fails', async () => {
    kimiWire.status = null;
    const { root, app } = await mountKimiWebModal({ bridge: bridgeStub(undefined) });
    await vi.waitFor(() => expect(root.textContent).toContain('0.43.0'));

    clickTab(root, 'Token');
    await nextTick();
    await vi.waitFor(() => expect(root.textContent).toContain('No token data available'));
    app.unmount();
  });

  it('shows no token data when the bridge is not wired yet (pre Todo 25 seam)', async () => {
    kimiWire.status = null;
    const { root, app } = await mountKimiWebModal();
    await vi.waitFor(() => expect(root.textContent).toContain('0.43.0'));

    clickTab(root, 'Token');
    await nextTick();
    await vi.waitFor(() => expect(root.textContent).toContain('No token data available'));
    app.unmount();
  });
});

/**
 * Todo 23 — REST fallback for the token tab: `agent.status.updated` is volatile
 * and never replayed, so a fresh page has no bridge usage state and the live
 * session status endpoint is the honest fallback for the context bar. Kimi
 * reports no token counts there, so the fallback never fabricates token rows.
 */
describe('StatusMonitorModal kimi-web token tab REST fallback', () => {
  it('falls back to the session status context when the bridge state is empty', async () => {
    const { root, app } = await mountKimiWebModal({ bridge: bridgeStub(undefined) });
    await vi.waitFor(() => expect(root.textContent).toContain('0.43.0'));

    clickTab(root, 'Token');
    await vi.waitFor(() => expect(root.textContent).toContain('1,048,576'));

    // Context occupancy comes from the live session status endpoint: the limit
    // renders and the percent bar is computed from context_tokens (20,787).
    expect(root.textContent).not.toContain('No token data available');
    expect(root.querySelector('.token-usage-percent')?.textContent).toBe('2%');
    expect(root.querySelector<HTMLElement>('.token-usage-fill')?.style.width).toBe('2%');
    // The source is labeled and the unreported token rows are not fabricated.
    expect(root.textContent).toContain('session status');
    expect(root.textContent).not.toContain('Input tokens');

    // The status call goes through the bridge proxy with the bridge token; the
    // kimi bearer never reaches the browser.
    const statusCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/status'));
    expect(String(statusCall?.[0])).toBe(
      'http://localhost:23004/kimi-web/api/v1/sessions/session-1/status',
    );
    const statusInit = statusCall?.[1] as { headers?: Record<string, string> } | undefined;
    expect(statusInit?.headers?.Authorization).toBe(`Bearer ${BRIDGE_TOKEN}`);
    app.unmount();
  });

  it('keeps the bridge session state as the primary source (no status call)', async () => {
    const bridge = bridgeStub(
      bridgeState(
        { total: { inputOther: 1200, output: 340, inputCacheRead: 800, inputCacheCreation: 200 } },
        1280,
        2560,
      ),
    );
    const { root, app } = await mountKimiWebModal({ bridge });
    await vi.waitFor(() => expect(root.textContent).toContain('0.43.0'));

    clickTab(root, 'Token');
    await vi.waitFor(() => expect(root.textContent).toContain('1,200'));

    expect(root.textContent).toContain('Input tokens');
    expect(root.textContent).not.toContain('session status');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/status'))).toBe(false);
    app.unmount();
  });

  it('shows no token data when the bridge state is empty and the status fetch fails', async () => {
    kimiWire.status = null;
    const { root, app } = await mountKimiWebModal({ bridge: bridgeStub(undefined) });
    await vi.waitFor(() => expect(root.textContent).toContain('0.43.0'));

    clickTab(root, 'Token');
    await vi.waitFor(() => expect(root.textContent).toContain('No token data available'));
    expect(root.textContent).not.toContain('session status');
    app.unmount();
  });
});

describe('StatusMonitorModal kimi-web server tab', () => {
  it('reads health through the kimi-web bridge proxy URL', async () => {
    const { root, app } = await mountKimiWebModal();
    await vi.waitFor(() => expect(root.textContent).toContain('0.43.0'));

    expect(healthUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        backendKind: 'kimi-web',
        kimiWebBridgeUrl: BRIDGE_URL,
        kimiWebBridgeToken: BRIDGE_TOKEN,
      }),
    );
    expect(root.textContent).toContain('Healthy');
    expect(root.textContent).toContain('0.43.0');

    // D3: the kimi-web path consults the registered adapter first for the
    // version; with this file's throwing mock it falls back to the bridge
    // /healthz version (0.43.0 in this fixture).
    expect(adapterMock.getAdapter).toHaveBeenCalled();

    // REST goes through the bridge proxy with the bridge token; the kimi
    // bearer never reaches the browser.
    const metaCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/v1/meta'));
    expect(String(metaCall?.[0])).toBe('http://localhost:23004/kimi-web/api/v1/meta');
    const metaInit = metaCall?.[1] as { headers?: Record<string, string> } | undefined;
    expect(metaInit?.headers?.Authorization).toBe(`Bearer ${BRIDGE_TOKEN}`);
    app.unmount();
  });

  it('renders meta.capabilities and auth.models_ready', async () => {
    const { root, app } = await mountKimiWebModal();
    await vi.waitFor(() => expect(root.textContent).toContain('Ready'));

    // Live-measured envelope (w0-p3-meta-ledger.md): all six keys report true.
    expect(root.textContent).toContain('websocket, file_upload, fs_query, mcp, tasks, terminal');
    const readyDot = [...root.querySelectorAll('.status-monitor-row')]
      .find((row) => row.textContent?.includes('Models ready'))
      ?.querySelector('.status-dot');
    expect(readyDot?.className).toContain('status-dot-success');
    app.unmount();
  });

  it('renders models_ready false as not ready, never as ready', async () => {
    kimiWire.auth.data = { models_ready: false };
    const { root, app } = await mountKimiWebModal();
    await vi.waitFor(() => expect(root.textContent).toContain('Not ready'));

    expect(root.textContent).not.toContain('Ready');
    const readyDot = [...root.querySelectorAll('.status-monitor-row')]
      .find((row) => row.textContent?.includes('Models ready'))
      ?.querySelector('.status-dot');
    expect(readyDot?.className).toContain('status-dot-error');
    app.unmount();
  });

  it('degrades gracefully when meta omits capabilities and auth omits models_ready', async () => {
    kimiWire.meta.data = { server_version: '0.43.0', backend: 'v2' };
    kimiWire.auth.data = {};
    const { root, app } = await mountKimiWebModal();
    await vi.waitFor(() => {
      const rows = [...root.querySelectorAll('.status-monitor-row')];
      expect(rows.some((row) => row.textContent?.includes('Capabilities'))).toBe(true);
    });

    const unavailable = [...root.querySelectorAll('.status-monitor-row')].filter((row) =>
      row.textContent?.includes('Unavailable'),
    );
    expect(unavailable).toHaveLength(2);
    app.unmount();
  });

  it('keeps previous meta/auth values when a later fetch fails (stale, not blank)', async () => {
    const { root, app } = await mountKimiWebModal();
    await vi.waitFor(() => expect(root.textContent).toContain('websocket, file_upload, fs_query, mcp'));
    const callsBefore = fetchMock.mock.calls.length;

    kimiWire.meta = { code: 40101, msg: 'unauthorized', request_id: 'req-meta', data: null };
    root.querySelector<HTMLButtonElement>('.refresh-button')?.click();
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore + 2));

    expect(root.textContent).toContain('websocket, file_upload, fs_query, mcp');
    expect(root.textContent).toContain('Ready');
    expect(root.textContent).toContain('Healthy');
    app.unmount();
  });
});

describe('StatusMonitorModal kimi-web capability-gated unsupported copy', () => {
  it.each([
    ['LSP', 'Structured LSP status is not exposed by Kimi Web.'],
    ['Plugins', 'Structured plugin status is not exposed by Kimi Web.'],
    ['Skills', 'Structured skill status is not exposed by Kimi Web.'],
  ] as const)('shows the Kimi Web copy on the %s tab', async (label, message) => {
    const { root, app } = await mountKimiWebModal();
    await vi.waitFor(() => expect(root.textContent).toContain('0.43.0'));

    clickTab(root, label);
    await nextTick();
    await vi.waitFor(() => expect(root.textContent).toContain(message));
    expect(root.textContent).not.toContain('not exposed by this backend');
    expect(root.textContent).not.toContain('not exposed by this ACP agent');
    app.unmount();
  });

  it('shows the supported-but-empty copy on the MCP tab (live meta.capabilities.mcp)', async () => {
    const { root, app } = await mountKimiWebModal();
    await vi.waitFor(() => expect(root.textContent).toContain('0.43.0'));

    clickTab(root, 'MCP');
    await nextTick();
    await vi.waitFor(() => expect(root.textContent).toContain('No MCP servers configured.'));
    expect(root.textContent).not.toContain('Structured MCP status is not exposed by Kimi Web.');
    expect(root.querySelector('.retry-button')).toBeNull();
    app.unmount();
  });

  it('keeps the OpenCode-worded copy for the opencode backend', async () => {
    adapterMock.getAdapter.mockReturnValue(openCodeAdapter());
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
              activeBackendKind: 'opencode',
              sessionId: SESSION_ID,
              codexApi: useCodexApi(),
            });
        },
      }),
    );
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
    app.mount(root);
    open.value = true;
    await nextTick();
    await vi.waitFor(() => expect(root.textContent).toContain('0.43.0'));

    clickTab(root, 'Skills');
    await nextTick();
    await vi.waitFor(() =>
      expect(root.textContent).toContain('The current OpenCode version does not support viewing skill status.'),
    );
    expect(root.textContent).not.toContain('not exposed by Kimi Web');
    app.unmount();
  });
});
