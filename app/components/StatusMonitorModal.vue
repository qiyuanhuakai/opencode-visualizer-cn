<script setup lang="ts">
import { ref, watch, computed, nextTick, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import {
  getCodexWeeklyRateLimitWindow,
  type CodexPlugin,
} from '../backends/codex/codexAdapter';
import type { BackendKind } from '../backends/types';
import {
  DEFAULT_KIMI_WEB_BRIDGE_URL,
  KIMI_WEB_CAPABILITIES,
  getActiveBackendAdapter,
} from '../backends/registry';
import {
  kimiWebContextOnlyUsage,
  kimiWebTokenUsageFromReport,
  type KimiWebTokenUsage,
} from '../backends/kimiWeb/tokenUsage';
import { useMessages } from '../composables/useMessages';
import type { useCodexApi } from '../composables/useCodexApi';
import type { KimiWebBridgeSessionState } from '../composables/kimiWebMessageBridgeTypes';
import { resolveDesktopBridgeHealthUrl } from '../composables/useDesktopBridgeVersion';
import type { MessageUsage } from '../types/message';
import type { MessageInfo } from '../types/sse';
import { parseCodexThreadTokenUsage } from '../backends/codex/tokenUsage';
import type { MagicContextWorker } from '../utils/pluginCompatibility';
import { createKimiWebClient, type KimiWebAuth, type KimiWebMeta } from '../utils/kimiWeb';
import { kimiWebProxyHttpUrl, kimiWebWsUrl } from '../utils/kimiWebWs';
import { StorageKeys, storageGet } from '../utils/storageKeys';
import CodexAccountTokenUsage from './codex/CodexAccountTokenUsage.vue';
import KimiAccountUsage from './kimiWeb/KimiAccountUsage.vue';
import AcpManagerPanel from './AcpManagerPanel.vue';
import KimiWebPluginManager from './kimiWeb/KimiWebPluginManager.vue';
import { createKimiWebPluginsClient } from '../utils/kimiWebPlugins';

type CodexApi = ReturnType<typeof useCodexApi>;

/**
 * Kimi Web seam (Todo 20 → Todo 25): the bridge instance
 * (`useKimiWebMessageBridge`, Todo 14) is owned by App.vue's serial chain, so
 * the modal only consumes the per-session state it exposes. Until App.vue
 * passes it, the kimi-web Token tab shows "no data" instead of guessing.
 */
type KimiWebSessionStateReader = {
  sessionState(sessionId: string): KimiWebBridgeSessionState | undefined;
};

const props = defineProps<{
  open: boolean;
  initialTab?: TabId;
  initialUsageView?: 'daily' | 'weekly' | 'cumulative';
  sessionId?: string;
  codexApi: CodexApi;
  preload: boolean;
  activeBackendKind: BackendKind;
  magicContextWorkers?: readonly MagicContextWorker[];
  kimiWebBridge?: KimiWebSessionStateReader;
}>();
const emit = defineEmits<{ close: [] }>();

const { t, locale } = useI18n();
const popoverRef = ref<HTMLDivElement | null>(null);
const msg = useMessages();
const codexApi = props.codexApi;
const codexSessionUsage = computed(() => props.activeBackendKind === 'codex' && props.sessionId
  ? parseCodexThreadTokenUsage(codexApi.tokenUsage.value, props.sessionId) : null);
const codexSessionCopy = computed(() => locale.value.startsWith('zh') ? {
  title: '当前会话', unavailable: '暂无当前会话的 Token 数据；完成一次请求后会更新。',
  total: '会话累计', latest: '最近一次请求', input: '输入', output: '输出',
  reasoning: '推理输出', cache: '缓存输入（读 / 写）', window: '模型上下文窗口',
  context: '最近一次输入 / 窗口',
} : {
  title: 'Current session', unavailable: 'No token data for this session yet. It updates after a request completes.',
  total: 'Session total', latest: 'Latest request', input: 'Input', output: 'Output',
  reasoning: 'Reasoning output', cache: 'Cached input (read / write)', window: 'Model context window',
  context: 'Latest input / window',
});
const codexContextPercent = computed(() => {
  const usage = codexSessionUsage.value;
  return usage?.modelContextWindow ? Math.round(usage.last.inputTokens / usage.modelContextWindow * 100) : null;
});

function backend() {
  return getActiveBackendAdapter();
}

function requireBackendMethod<T extends (...args: never[]) => unknown>(method: T | undefined, name: string): T {
  if (!method) throw new Error(`Active backend does not support ${name}.`);
  return method;
}

type TabId = 'server' | 'mcp' | 'lsp' | 'plugins' | 'skills' | 'token' | 'mc' | 'acp';
function availableTab(tab: TabId | undefined): TabId {
  return tab === 'mc' && props.activeBackendKind !== 'opencode' ? 'server' : tab ?? 'server';
}
const activeTab = ref<TabId>(availableTab(props.initialTab));
const tablistRef = ref<HTMLDivElement | null>(null);
function revealActiveTab() {
  tablistRef.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}
watch(tablistRef, (tablist, _previous, onCleanup) => {
  if (!tablist) return;
  const observer = new ResizeObserver(revealActiveTab);
  observer.observe(tablist);
  onCleanup(() => observer.disconnect());
});
watch([() => props.open, activeTab], async ([open]) => {
  if (!open) return;
  await nextTick();
  revealActiveTab();
}, { immediate: true, flush: 'post' });
const accountUsageRef = ref<InstanceType<typeof CodexAccountTokenUsage> | null>(null);
const kimiAccountUsageRef = ref<InstanceType<typeof KimiAccountUsage> | null>(null);
watch(() => props.initialTab, (tab) => { if (props.open && tab) activeTab.value = availableTab(tab); });
const acpManagerRef = ref<{ refresh: () => Promise<void> } | null>(null);

const serverHealth = ref<{ healthy: boolean; version: string } | null>(null);
const mcpData = ref<
  Record<
    string,
    | { status: 'connected' }
    | { status: 'configured' }
    | { status: 'disabled' }
    | { status: 'failed'; error: string }
    | { status: 'needs_auth' }
    | { status: 'needs_client_registration'; error: string }
  >
  | null
>(null);
const lspData = ref<Array<{ id: string; name: string; root: string; status: 'connected' | 'error' }> | null>(null);
const skillData = ref<Array<{ name: string; version?: string; enabled?: boolean; path?: string }> | null>(null);
const skillUnsupported = ref(false);
const mcpUnsupported = ref(false);
const lspUnsupported = ref(false);
const pluginUnsupported = ref(false);
const isAcpBackend = computed(() => props.activeBackendKind === 'acp');
const isKimiWebBackend = computed(() => props.activeBackendKind === 'kimi-web');
const mcpUnsupportedText = computed(() => {
  if (isKimiWebBackend.value) return t('statusMonitor.mcp.unsupportedKimiWeb');
  return t(isAcpBackend.value ? 'statusMonitor.mcp.unsupportedAcp' : 'statusMonitor.mcp.unsupported');
});
const lspUnsupportedText = computed(() => {
  if (isKimiWebBackend.value) return t('statusMonitor.lsp.unsupportedKimiWeb');
  return t(isAcpBackend.value ? 'statusMonitor.lsp.unsupportedAcp' : 'statusMonitor.lsp.unsupported');
});
const skillUnsupportedText = computed(() => {
  if (isKimiWebBackend.value) return t('statusMonitor.skills.unsupportedKimiWeb');
  return t(
    isAcpBackend.value ? 'statusMonitor.skills.unsupportedAcp' : 'statusMonitor.skills.unsupported',
  );
});
const pluginUnsupportedText = computed(() => {
  if (isKimiWebBackend.value) return t('statusMonitor.plugins.unsupportedKimiWeb');
  return t(
    isAcpBackend.value
      ? 'statusMonitor.plugins.unsupportedAcp'
      : 'statusMonitor.plugins.unsupported',
  );
});
const configData = ref<Record<string, unknown> | null>(null);
const codexPluginData = ref<CodexPlugin[]>([]);
const backendPluginData = ref<Array<{
  id: string;
  name: string;
  enabled: boolean;
  installed: boolean;
  accessible: boolean;
}>>([]);
const tokenUsage = ref<MessageUsage | null>(null);
const tokenModelName = ref<string>('');
const tokenContextLimit = ref<number>(0);
/** Kimi Web context occupancy (`contextTokens`); 0 for every other backend. */
const tokenContextUsed = ref<number>(0);
const tokenContextAvailable = ref(false);
const tokenUserMessages = ref<number>(0);
const tokenAssistantMessages = ref<number>(0);
/** True when neither live nor persisted cumulative token usage is available. */
const tokenUsageContextOnly = ref(false);
const tokenLoading = ref(false);
const kimiMeta = ref<KimiWebMeta | null>(null);
const kimiAuth = ref<KimiWebAuth | null>(null);
const codexApiKeyInput = ref('');

const loading = ref(false);
const errorMessage = ref('');
const togglingMcp = ref<string | null>(null);
const togglingSkill = ref<string | null>(null);
const hasLoaded = ref(false);

let refreshPromise: Promise<void> | null = null;
let refreshPromiseRequestId = 0;
let refreshRequestId = 0;
let tokenRequestId = 0;

let clickHandler: ((e: MouseEvent) => void) | null = null;
let escHandler: ((e: KeyboardEvent) => void) | null = null;
let clickTimeoutId: ReturnType<typeof setTimeout> | null = null;

function bindEvents() {
  escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && props.open) emit('close');
  };
  document.addEventListener('keydown', escHandler);
}

function unbindEvents() {
  if (clickTimeoutId !== null) {
    clearTimeout(clickTimeoutId);
    clickTimeoutId = null;
  }
  if (clickHandler) {
    document.removeEventListener('click', clickHandler);
    clickHandler = null;
  }
  if (escHandler) {
    document.removeEventListener('keydown', escHandler);
    escHandler = null;
  }
}

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    if (props.initialTab) activeTab.value = availableTab(props.initialTab);
    // Defer click binding to skip the current click event that opened the panel
    clickTimeoutId = setTimeout(() => {
      clickTimeoutId = null;
      clickHandler = (e: MouseEvent) => {
        if (popoverRef.value && !popoverRef.value.contains(e.target as Node)) {
          emit('close');
        }
      };
      document.addEventListener('click', clickHandler);
    }, 0);
    bindEvents();
    void ensureLoaded();
  } else {
    unbindEvents();
  }
});

watch(() => props.preload, (shouldPreload) => {
  if (shouldPreload) {
    void ensureLoaded();
  } else if (!props.open) {
    resetLoadedState();
  }
}, { immediate: true });

watch(
  () => props.sessionId,
  (newId, oldId) => {
    if (newId === oldId) return;
    resetTokenData();
    if (newId && (props.open || props.preload)) {
      void fetchTokenData();
    }
  },
);

watch(() => props.activeBackendKind, (newKind, oldKind) => {
  if (newKind === oldKind) return;
  if (newKind !== 'opencode' && activeTab.value === 'mc') activeTab.value = 'server';
  // Backend switched while modal is mounted: mcpData/lspData/skillData are
  // from the OLD backend, so wipe and re-fetch with the NEW backend.
  resetLoadedState();
  if (props.open || props.preload) {
    void ensureLoaded();
  }
});

onBeforeUnmount(() => {
  unbindEvents();
});

function resetTokenData() {
  tokenRequestId++;
  tokenLoading.value = false;
  tokenUsage.value = null;
  tokenModelName.value = '';
  tokenContextLimit.value = 0;
  tokenContextUsed.value = 0;
  tokenContextAvailable.value = false;
  tokenUserMessages.value = 0;
  tokenAssistantMessages.value = 0;
  tokenUsageContextOnly.value = false;
}

function resetLoadedState() {
  refreshRequestId++;
  refreshPromise = null;
  refreshPromiseRequestId = 0;
  loading.value = false;
  hasLoaded.value = false;
  errorMessage.value = '';
  skillUnsupported.value = false;
  mcpUnsupported.value = false;
  lspUnsupported.value = false;
  pluginUnsupported.value = false;
  serverHealth.value = null;
  mcpData.value = null;
  lspData.value = null;
  skillData.value = null;
  configData.value = null;
  codexPluginData.value = [];
  backendPluginData.value = [];
  kimiMeta.value = null;
  kimiAuth.value = null;
  resetTokenData();
}

function hasCoreStatusData() {
  return serverHealth.value !== null
    && mcpData.value !== null
    && lspData.value !== null
    && configData.value !== null;
}

async function refresh() {
  if (refreshPromise && refreshPromiseRequestId === refreshRequestId) return refreshPromise;

  const requestId = ++refreshRequestId;
  loading.value = true;
  errorMessage.value = '';
  const tokenRefresh = props.sessionId ? fetchTokenData() : Promise.resolve();

  if (isKimiWebBackend.value) {
    // Kimi Web reads its status surfaces from the live REST envelope: the
    // version comes from the registered adapter's `getGlobalHealth()`
    // (`meta.server_version`, D3) and MCP support follows the live
    // `meta.capabilities.mcp` bit (D4). Fail closed until the meta lands;
    // `refreshKimiWebStatus` re-applies the flags once it has.
    applyKimiWebStatusSurfaceSupport();
    const currentRefresh = (async () => {
      try {
        await refreshKimiWebStatus(requestId);
        if (requestId !== refreshRequestId) return;
        await tokenRefresh;
        if (requestId !== refreshRequestId) return;
      } catch {
        if (requestId === refreshRequestId) {
          errorMessage.value = t('statusMonitor.error');
          hasLoaded.value = false;
        }
      }
    })();
    refreshPromise = currentRefresh;
    refreshPromiseRequestId = requestId;
    void currentRefresh.then(
      () => finishRefresh(requestId, currentRefresh),
      () => finishRefresh(requestId, currentRefresh),
    );
    return currentRefresh;
  }

  const activeBackend = backend();
  mcpUnsupported.value = typeof activeBackend.getMcpStatus !== 'function';
  lspUnsupported.value = typeof activeBackend.getLspStatus !== 'function';
  skillUnsupported.value = typeof activeBackend.getSkillStatus !== 'function';
  pluginUnsupported.value = isAcpBackend.value
    ? typeof activeBackend.getPluginStatus !== 'function'
    : typeof activeBackend.getPluginStatus !== 'function' &&
      typeof activeBackend.getGlobalConfig !== 'function';

  const currentRefresh = (async () => {
    try {
      const [health, mcp, lsp, skills, cfg, plugins] = await Promise.allSettled([
        activeBackend.getGlobalHealth?.() ?? Promise.resolve(null),
        activeBackend.getMcpStatus?.() ?? Promise.resolve({}),
        activeBackend.getLspStatus?.() ?? Promise.resolve([]),
        activeBackend.getSkillStatus?.() ?? Promise.resolve([]),
        activeBackend.getGlobalConfig?.() ?? Promise.resolve({}),
        activeBackend.getPluginStatus?.() ?? Promise.resolve([]),
      ]);
      if (requestId !== refreshRequestId) return;
      serverHealth.value = health.status === 'fulfilled' ? health.value : null;
      mcpData.value =
        mcp.status === 'fulfilled' ? ((mcp.value as typeof mcpData.value) ?? {}) : null;
      lspData.value =
        lsp.status === 'fulfilled' ? ((lsp.value as typeof lspData.value) ?? []) : null;
      skillData.value =
        skills.status === 'fulfilled' ? ((skills.value as typeof skillData.value) ?? []) : null;
      configData.value = cfg.status === 'fulfilled' ? (cfg.value as Record<string, unknown>) : null;
      backendPluginData.value =
        plugins.status === 'fulfilled' ? (plugins.value as typeof backendPluginData.value) : [];
      if (!mcpUnsupported.value && mcp.status === 'rejected') mcpUnsupported.value = true;
      if (!lspUnsupported.value && lsp.status === 'rejected') lspUnsupported.value = true;
      if (!skillUnsupported.value && skills.status === 'rejected') skillUnsupported.value = true;
      if (!pluginUnsupported.value && plugins.status === 'rejected') {
        if (isAcpBackend.value || cfg.status === 'rejected') pluginUnsupported.value = true;
      }

      await tokenRefresh;
      if (requestId !== refreshRequestId) return;
      await refreshCodexStatus(requestId);
      if (requestId !== refreshRequestId) return;

      if (
        health.status === 'rejected' &&
        mcp.status === 'rejected' &&
        lsp.status === 'rejected' &&
        cfg.status === 'rejected'
      ) {
        errorMessage.value = t('statusMonitor.error');
        hasLoaded.value = false;
      } else {
        hasLoaded.value = true;
      }
    } catch (e) {
      if (requestId !== refreshRequestId) return;
      errorMessage.value = t('statusMonitor.error');
      hasLoaded.value = false;
    }
  })();

  refreshPromise = currentRefresh;
  refreshPromiseRequestId = requestId;
  void currentRefresh.then(
    () => finishRefresh(requestId, currentRefresh),
    () => finishRefresh(requestId, currentRefresh),
  );
  return currentRefresh;
}

function finishRefresh(requestId: number, completedRefresh: Promise<void>) {
  if (requestId !== refreshRequestId || refreshPromise !== completedRefresh) return;
  loading.value = false;
  refreshPromise = null;
  refreshPromiseRequestId = 0;
}

async function handleRefresh() {
  if (activeTab.value === 'token') void kimiAccountUsageRef.value?.refresh();
  if (activeTab.value === 'token') void accountUsageRef.value?.refresh();
  if (activeTab.value === 'acp') {
    await acpManagerRef.value?.refresh();
    return;
  }
  await refresh();
}

async function ensureLoaded() {
  if (refreshPromise) {
    await refreshPromise;
    return;
  }
  if (hasLoaded.value && hasCoreStatusData()) return;
  await refresh();
}

async function refreshCodexStatus(requestId?: number) {
  if (props.activeBackendKind !== 'codex') return;
  if (codexApi.status.value !== 'connected') return;
  try {
    await Promise.allSettled([
      codexApi.refreshAccount(),
      codexApi.refreshAccountRateLimits(),
      codexApi.refreshPlugins(),
    ]);
    if (requestId === undefined || requestId === refreshRequestId) {
      codexPluginData.value = codexApi.plugins.value.slice();
    }
  } catch {
    if (requestId === undefined || requestId === refreshRequestId) {
      errorMessage.value = t('statusMonitor.error');
    }
  }
}

async function handleCodexApiKeyLogin() {
  const apiKey = codexApiKeyInput.value.trim();
  if (!apiKey) return;
  await codexApi.loginWithApiKey(apiKey);
  codexApiKeyInput.value = '';
  await refreshCodexStatus();
}

async function handleCodexLogout() {
  await codexApi.logoutAccount();
  await refreshCodexStatus();
}

const codexWeeklyRateLimit = computed(() =>
  getCodexWeeklyRateLimitWindow(codexApi.accountRateLimits.value),
);
const codexPlanType = computed(() => codexApi.accountPlanType.value
  ?? (codexApi.account.value?.type === 'chatgpt' ? codexApi.account.value.planType : null));
const codexFiveHourRateLimit = computed(() =>
  codexPlanType.value?.toLowerCase() === 'plus'
    ? [codexApi.accountRateLimits.value?.primary, codexApi.accountRateLimits.value?.secondary]
      .find((window) => window?.windowDurationMins === 5 * 60) ?? null
    : null,
);
function rateLimitPercent(usedPercent: number | undefined): number {
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return 0;
  return Math.max(0, Math.min(100, Math.round(usedPercent)));
}

async function fetchContextLimit(
  activeBackend: ReturnType<typeof backend>,
  providerId: string,
  modelId: string,
) {
  try {
    const listProviders = requireBackendMethod(activeBackend.listProviders, 'providers');
    const response = (await listProviders.call(activeBackend)) as {
      all?: Array<{ id: string; models?: Record<string, { limit?: { context?: number } }> }>;
    };
    const providers = Array.isArray(response?.all) ? response.all : [];
    const provider = providers.find((p) => p.id === providerId);
    if (provider?.models) {
      const model = provider.models[modelId];
      if (model?.limit?.context) {
        return model.limit.context;
      }
    }
  } catch {}
  return 0;
}

/**
 * Kimi Web status-surface support (D4). Support is derived from the LIVE
 * `meta.capabilities` where a key exists: the measured envelope carries
 * `websocket, file_upload, fs_query, mcp, tasks, terminal`, so today only
 * `mcp` can flip on. `lsp`, `skills` and `plugins` have no live key, so they
 * fall through to the static `KIMI_WEB_CAPABILITIES` lookup — which carries
 * no bit for them — and keep the fail-closed unsupported copy until a live
 * key or a wired adapter method says otherwise. Never claim support without
 * measured evidence.
 */
function kimiWebStatusSurfaceSupported(surface: 'mcp' | 'lsp' | 'skills' | 'plugins'): boolean {
  const liveCapabilities = kimiMeta.value?.capabilities;
  if (
    liveCapabilities &&
    typeof liveCapabilities === 'object' &&
    !Array.isArray(liveCapabilities) &&
    surface in liveCapabilities
  ) {
    return liveCapabilities[surface] === true;
  }
  return (KIMI_WEB_CAPABILITIES as unknown as Record<string, unknown>)[surface] === true;
}

/**
 * Applies the D4 surface flags from whatever live meta is currently held.
 * Runs before a kimi refresh (fail closed on stale/absent meta) and again
 * once the fresh meta lands, so a live `mcp: true` flips the MCP tab to the
 * supported-but-empty state and a failed meta keeps the unsupported copy.
 */
function applyKimiWebStatusSurfaceSupport() {
  mcpUnsupported.value = !kimiWebStatusSurfaceSupported('mcp');
  lspUnsupported.value = !kimiWebStatusSurfaceSupported('lsp');
  skillUnsupported.value = !kimiWebStatusSurfaceSupported('skills');
  pluginUnsupported.value = !kimiWebStatusSurfaceSupported('plugins');
}

function kimiWebBridgeCredentials() {
  return {
    bridgeUrl: storageGet(StorageKeys.auth.kimiWebBridgeUrl) ?? DEFAULT_KIMI_WEB_BRIDGE_URL,
    bridgeToken: storageGet(StorageKeys.auth.kimiWebBridgeToken) ?? '',
  };
}

const kimiWebPluginsClient = computed(() => {
  if (!props.open || !isKimiWebBackend.value) return null;
  return createKimiWebPluginsClient(kimiWebBridgeCredentials());
});

/** REST goes through the bridge proxy root; the bridge injects the kimi bearer. */
function createKimiWebStatusClient() {
  const { bridgeUrl, bridgeToken } = kimiWebBridgeCredentials();
  return createKimiWebClient({
    baseUrl: kimiWebProxyHttpUrl(kimiWebWsUrl(bridgeUrl, bridgeToken)),
    getToken: () => bridgeToken,
  });
}

/** Bridge `/healthz` (vis_bridge shape: `{ok, service, version}`) via the kimi-web proxy URL. */
async function fetchKimiWebBridgeHealth(healthUrl: string) {
  try {
    const response = await fetch(healthUrl, { credentials: 'omit' });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== 'object') return null;
    const record = body as { ok?: unknown; version?: unknown };
    return {
      healthy: record.ok === true,
      version: typeof record.version === 'string' ? record.version : '',
    };
  } catch {
    return null;
  }
}

/**
 * D3 version source: the registered kimi-web adapter answers
 * `getGlobalHealth()` from live `meta.server_version`, never from the bridge.
 * Returns null when no adapter is registered or the call fails, so the caller
 * can fall back to the bridge `/healthz` version.
 */
async function fetchKimiWebGlobalHealth(): Promise<{ healthy: boolean; version: string } | null> {
  try {
    const adapter = backend();
    const getGlobalHealth = adapter.getGlobalHealth;
    if (typeof getGlobalHealth !== 'function') return null;
    const health = await getGlobalHealth.call(adapter);
    if (!health || typeof health.version !== 'string') return null;
    return { healthy: health.healthy !== false, version: health.version };
  } catch {
    return null;
  }
}

async function refreshKimiWebStatus(requestId: number) {
  const { bridgeUrl, bridgeToken } = kimiWebBridgeCredentials();
  const healthUrl = resolveDesktopBridgeHealthUrl({
    backendKind: 'kimi-web',
    acpBridgeUrl: '',
    acpBridgeToken: '',
    codexBridgeUrl: '',
    codexBridgeToken: '',
    kimiWebBridgeUrl: bridgeUrl,
    kimiWebBridgeToken: bridgeToken,
  });
  const client = createKimiWebStatusClient();
  const [adapterHealth, health, meta, auth] = await Promise.allSettled([
    fetchKimiWebGlobalHealth(),
    fetchKimiWebBridgeHealth(healthUrl),
    client.getMeta(),
    client.getAuth(),
  ]);
  if (requestId !== refreshRequestId) return;
  // A failed meta/auth keeps the previous values (stale) instead of blanking
  // the tab; only an explicit reset (backend switch / modal close) clears them.
  if (meta.status === 'fulfilled') kimiMeta.value = meta.value;
  if (auth.status === 'fulfilled') kimiAuth.value = auth.value;
  // The adapter answers from `meta.server_version`; the bridge `/healthz`
  // version is only the fallback for when no adapter answered.
  serverHealth.value =
    adapterHealth.status === 'fulfilled' && adapterHealth.value !== null
      ? adapterHealth.value
      : health.status === 'fulfilled'
        ? health.value
        : null;
  // MCP support follows the live capabilities we just read (D4).
  applyKimiWebStatusSurfaceSupport();
  const allFailed =
    health.status === 'rejected' && meta.status === 'rejected' && auth.status === 'rejected';
  if (allFailed) {
    errorMessage.value = t('statusMonitor.error');
    hasLoaded.value = false;
  } else {
    hasLoaded.value = true;
  }
}

// Context and the active model come from session status; cumulative usage is
// latest-wins live data or the persisted snapshot, never their sum.
async function fetchKimiWebTokenData(sessionId: string) {
  const requestId = ++tokenRequestId;
  tokenLoading.value = true;
  const client = createKimiWebStatusClient();
  const initialUsage = props.kimiWebBridge?.sessionState(sessionId)?.usage;
  const [statusResult, modelsResult, snapshotResult] = await Promise.allSettled([
    client.getSessionStatus(sessionId),
    client.listModels(),
    initialUsage?.total ? Promise.resolve(null) : client.getSnapshot(sessionId),
  ]);
  if (requestId !== tokenRequestId || props.sessionId !== sessionId) return;
  const status = statusResult.status === 'fulfilled' ? statusResult.value : null;
  tokenContextAvailable.value = status !== null;
  const liveUsage = props.kimiWebBridge?.sessionState(sessionId)?.usage;
  const savedUsage = snapshotResult.status === 'fulfilled' ? snapshotResult.value?.session.usage : undefined;
  const usage = liveUsage?.total ? liveUsage : savedUsage ? { total: {
    inputOther: savedUsage.input_tokens,
    output: savedUsage.output_tokens,
    inputCacheRead: savedUsage.cache_read_tokens,
    inputCacheCreation: savedUsage.cache_creation_tokens,
  } } : undefined;
  const mapped = kimiWebTokenUsageFromReport(usage, status?.context_tokens, status?.max_context_tokens);
  const contextOnly = !mapped;
  const models = modelsResult.status === 'fulfilled' ? modelsResult.value.items : [];
  const model = models.find((item) => item.model === status?.model || `${item.provider}/${item.model}` === status?.model);
  applyKimiWebTokenData(sessionId, requestId,
    mapped ?? (status ? kimiWebContextOnlyUsage(status.context_tokens, status.max_context_tokens) : null),
    contextOnly, model?.display_name || status?.model || '',
  );
}

const kimiUsageState = computed(() => {
  if (!isKimiWebBackend.value || !props.sessionId) return undefined;
  return props.kimiWebBridge?.sessionState(props.sessionId);
});
watch(activeTab, (tab) => {
  if (tab === 'token' && isKimiWebBackend.value && props.open && props.sessionId) {
    void fetchKimiWebTokenData(props.sessionId);
  }
});
watch([
  () => kimiUsageState.value?.usage,
  () => kimiUsageState.value?.contextTokens,
  () => kimiUsageState.value?.maxContextTokens,
], () => {
  if (props.sessionId && (props.open || props.preload)) fetchKimiWebTokenData(props.sessionId);
});

function applyKimiWebTokenData(
  sessionId: string,
  requestId: number,
  mapped: KimiWebTokenUsage | null,
  contextOnly: boolean,
  modelName: string,
) {
  let userCount = 0;
  let assistantCount = 0;
  for (const root of msg.roots.value.filter((root) => root.sessionID === sessionId)) {
    for (const info of msg.getThread(root.id)) {
      if (info.role === 'user') {
        userCount++;
      } else if (info.role === 'assistant') {
        assistantCount++;
      }
    }
  }
  if (requestId !== tokenRequestId || props.sessionId !== sessionId) return;
  if (!mapped) {
    resetTokenData();
    return;
  }
  tokenUsage.value = mapped.usage;
  tokenContextLimit.value = mapped.contextLimit;
  tokenContextUsed.value = mapped.contextUsed;
  tokenUsageContextOnly.value = contextOnly;
  tokenModelName.value = modelName;
  tokenUserMessages.value = userCount;
  tokenAssistantMessages.value = assistantCount;
  tokenLoading.value = false;
}


async function fetchTokenData() {
  const sessionId = props.sessionId;
  if (!sessionId) {
    resetTokenData();
    return;
  }

  if (props.activeBackendKind === 'codex') {
    tokenLoading.value = false;
    return;
  }

  if (isKimiWebBackend.value) {
    await fetchKimiWebTokenData(sessionId);
    return;
  }

  const requestId = ++tokenRequestId;
  tokenLoading.value = true;
  tokenContextLimit.value = 0;
  const activeBackend = backend();

  // Try to get messages from useMessages store first
  let sessionMessages: MessageInfo[] = [];
  const sessionRoots = msg.roots.value.filter((root) => root.sessionID === sessionId);
  for (const root of sessionRoots) {
    sessionMessages.push(...msg.getThread(root.id));
  }

  // If store doesn't have this session's messages, load via API
  if (sessionMessages.length === 0) {
    try {
      const listSessionMessages = requireBackendMethod(
        activeBackend.listSessionMessages,
        'session messages',
      );
      const messages = await listSessionMessages.call(activeBackend, sessionId, { limit: 100 });
      if (requestId !== tokenRequestId || props.sessionId !== sessionId) return;
      if (Array.isArray(messages) && messages.length > 0) {
        msg.loadHistory(messages);
        // Re-fetch from store after loading
        const newRoots = msg.roots.value.filter((root) => root.sessionID === sessionId);
        for (const root of newRoots) {
          sessionMessages.push(...msg.getThread(root.id));
        }
      }
    } catch {
      if (requestId === tokenRequestId && props.sessionId === sessionId) {
        resetTokenData();
      }
      return;
    }
  }

  if (sessionMessages.length === 0) {
    if (requestId === tokenRequestId && props.sessionId === sessionId) {
      resetTokenData();
    }
    return;
  }

  // Sort by created time
  sessionMessages.sort((a, b) => (a.time.created ?? 0) - (b.time.created ?? 0));

  // Extract token data using normalized usage from store
  let userCount = 0;
  let assistantCount = 0;
  let latestUsage: MessageUsage | null = null;
  let latestModelName = '';

  for (const info of sessionMessages) {
    if (info.role === 'user') {
      userCount++;
    } else if (info.role === 'assistant') {
      assistantCount++;
      const usage = msg.getUsage(info.id);
      // Use the last assistant message with valid token data
      // (skip streaming messages that haven't received tokens yet)
      if (usage && (usage.tokens.input > 0 || usage.tokens.output > 0)) {
        latestUsage = usage;
        latestModelName = usage.modelId || '';
      }
    }
  }

  if (requestId !== tokenRequestId || props.sessionId !== sessionId) return;

  tokenUsage.value = latestUsage;
  tokenModelName.value = latestModelName;
  tokenUserMessages.value = userCount;
  tokenAssistantMessages.value = assistantCount;

  // Fetch model context limit
  let contextLimit = 0;
  if (latestUsage?.providerId && latestUsage?.modelId) {
    contextLimit = await fetchContextLimit(
      activeBackend,
      latestUsage.providerId,
      latestUsage.modelId,
    );
  }
  if (requestId === tokenRequestId && props.sessionId === sessionId) {
    tokenContextLimit.value = contextLimit;
    tokenLoading.value = false;
  }
}

const mcpEntries = computed(() => {
  if (!mcpData.value) return [];
  return Object.entries(mcpData.value).map(([name, item]) => ({ name, ...item }));
});

const pluginEntries = computed(() => {
  if (codexPluginData.value.length > 0) {
    return codexPluginData.value
      .filter((plugin) => plugin.isAccessible)
      .map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        enabled: plugin.isEnabled,
        installed: plugin.state === 'installed',
        accessible: plugin.isAccessible,
      }));
  }
  if (backendPluginData.value.length > 0) return backendPluginData.value;
  const plugins = configData.value?.plugin;
  if (Array.isArray(plugins)) return plugins.map((p) => ({ id: String(p), name: String(p), enabled: true, installed: true, accessible: true }));
  if (typeof plugins === 'object' && plugins !== null) return Object.keys(plugins).map((name) => ({ id: name, name, enabled: true, installed: true, accessible: true }));
  return [];
});

const hiddenPluginCount = computed(() => {
  if (codexPluginData.value.length === 0) return 0;
  return codexPluginData.value.filter((plugin) => !plugin.isAccessible).length;
});

const pluginStats = computed(() => {
  const source = codexPluginData.value;
  if (source.length === 0) {
    return {
      marketplaces: 0,
      total: pluginEntries.value.length,
      accessible: pluginEntries.value.filter((plugin) => plugin.accessible).length,
      enabled: pluginEntries.value.filter((plugin) => plugin.enabled).length,
      installed: pluginEntries.value.filter((plugin) => plugin.installed).length,
    };
  }
  return {
    marketplaces: codexApi.pluginMarketplaceCount.value,
    total: source.length,
    accessible: source.filter((plugin) => plugin.isAccessible).length,
    enabled: source.filter((plugin) => plugin.isEnabled).length,
    installed: source.filter((plugin) => plugin.state === 'installed').length,
  };
});

const skillEntries = computed(() => {
  if (skillData.value) {
    return skillData.value.map((s) => ({
      name: s.name,
      enabled: s.enabled,
      path: s.path,
    }));
  }
  const skills = configData.value?.skills;
  if (Array.isArray(skills)) return skills.map((s) => (typeof s === 'string' ? s : s?.name || String(s))).map((name) => ({ name, enabled: undefined as boolean | undefined, path: undefined as string | undefined }));
  if (typeof skills === 'object' && skills !== null) return Object.keys(skills).map((name) => ({ name, enabled: undefined as boolean | undefined, path: undefined as string | undefined }));
  return [];
});

async function handleSkillToggle(name: string, currentEnabled: boolean | undefined, path: string | undefined) {
  const updateSkill = backend().updateSkill;
  if (typeof updateSkill !== 'function') {
    errorMessage.value = t('statusMonitor.skills.toggleFailed');
    return;
  }
  // Codex's skills/config/write is keyed by path; fall back to name for
  // backends that accept a name-based key (forward-compat).
  const key = path ?? name;
  if (!key) {
    errorMessage.value = t('statusMonitor.skills.toggleFailed');
    return;
  }
  const nextEnabled = !currentEnabled;
  togglingSkill.value = name;
  try {
    await updateSkill({ path: key, name, enabled: nextEnabled });
    if (skillData.value) {
      const entry = skillData.value.find((s) => s.name === name);
      if (entry) entry.enabled = nextEnabled;
    }
    // Sync the shared codexApi.skills.value so downstream consumers
    // (e.g. App.vue's availableSkills computed -> $ mention popup) see
    // the new enabled state without waiting for a page refresh. Only
    // valid on the Codex backend; no-op otherwise because the toggle
    // UI is gated on `enabled` being present (i.e. Codex-only).
    if (props.activeBackendKind === 'codex' && codexApi.connected) {
      await codexApi.refreshSkills();
    }
  } catch (e) {
    errorMessage.value = t('statusMonitor.skills.toggleFailed');
  } finally {
    togglingSkill.value = null;
  }
}

async function handleMcpToggle(name: string, currentStatus: string) {
  const nextEnabled = currentStatus === 'disabled';
  const mcpConfigs = configData.value?.mcp_servers ?? configData.value?.mcp;
  const baseConfig =
    typeof mcpConfigs === 'object' && mcpConfigs !== null
      ? (mcpConfigs as Record<string, Record<string, unknown>>)[name]
      : undefined;

  if (!baseConfig || typeof baseConfig !== 'object') {
    errorMessage.value = t('statusMonitor.mcp.toggleFailed');
    return;
  }

  togglingMcp.value = name;
  try {
    const updateMcp = requireBackendMethod(backend().updateMcp, 'MCP updates');
    await updateMcp({
      name,
      config: { ...baseConfig, enabled: nextEnabled },
    });
    if (mcpData.value) {
      mcpData.value[name] = nextEnabled
        ? { status: 'connected' }
        : { status: 'disabled' };
    }
  } catch (e) {
    errorMessage.value = t('statusMonitor.mcp.toggleFailed');
  } finally {
    togglingMcp.value = null;
  }
}

function mcpStatusText(status: string) {
  switch (status) {
    case 'connected':
      return t('statusMonitor.mcp.connected');
    case 'configured':
      return t(isAcpBackend.value ? 'statusMonitor.mcp.configuredAcp' : 'statusMonitor.mcp.configured');
    case 'disabled':
      return t('statusMonitor.mcp.disabled');
    case 'failed':
      return t('statusMonitor.mcp.failed');
    case 'needs_auth':
      return t('statusMonitor.mcp.needsAuth');
    case 'needs_client_registration':
      return t('statusMonitor.mcp.needsRegistration');
    default:
      return status;
  }
}

function mcpStatusClass(status: string) {
  switch (status) {
    case 'connected':
      return 'status-dot-success';
    case 'disabled':
      return 'status-dot-muted';
    case 'failed':
    case 'needs_client_registration':
      return 'status-dot-error';
    case 'needs_auth':
      return 'status-dot-warning';
    default:
      return 'status-dot-muted';
  }
}

function lspStatusClass(status: string) {
  return status === 'connected' ? 'status-dot-success' : 'status-dot-error';
}

function magicContextStatusClass(status: MagicContextWorker['status']) {
  if (status === 'busy') return 'status-dot-success';
  if (status === 'retry') return 'status-dot-warning';
  return 'status-dot-muted';
}

function magicContextStatusText(status: MagicContextWorker['status']) {
  return t(`statusMonitor.mc.states.${status}`);
}

const tabs = computed<{ id: TabId; labelKey: string }[]>(() => {
  const base: { id: TabId; labelKey: string }[] = [
    { id: 'server', labelKey: 'statusMonitor.tabs.server' },
    { id: 'mcp', labelKey: 'statusMonitor.tabs.mcp' },
    { id: 'lsp', labelKey: 'statusMonitor.tabs.lsp' },
    { id: 'plugins', labelKey: 'statusMonitor.tabs.plugins' },
    { id: 'skills', labelKey: 'statusMonitor.tabs.skills' },
    { id: 'token', labelKey: 'statusMonitor.tabs.token' },
  ];
  if (props.activeBackendKind === 'opencode') {
    base.push({ id: 'mc', labelKey: 'statusMonitor.tabs.mc' });
  }
  base.push({ id: 'acp', labelKey: 'statusMonitor.tabs.acp' });
  return base;
});

function handleTabKeydown(event: KeyboardEvent, index: number) {
  let nextIndex: number;
  switch (event.key) {
    case 'ArrowRight':
      nextIndex = (index + 1) % tabs.value.length;
      break;
    case 'ArrowLeft':
      nextIndex = (index - 1 + tabs.value.length) % tabs.value.length;
      break;
    case 'Home':
      nextIndex = 0;
      break;
    case 'End':
      nextIndex = tabs.value.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  activeTab.value = tabs.value[nextIndex]?.id ?? activeTab.value;
  void nextTick(() => {
    tablistRef.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
  });
}

const currentTotalInfo = computed(() => {
  switch (activeTab.value) {
    case 'server':
      return null;
    case 'mcp':
      return mcpEntries.value.length > 0
        ? { label: t('statusMonitor.common.totalLabel'), count: mcpEntries.value.length }
        : null;
    case 'lsp':
      return (lspData.value || []).length > 0
        ? { label: t('statusMonitor.common.totalLabel'), count: (lspData.value || []).length }
        : null;
    case 'plugins':
      return null;
    case 'skills':
      return skillEntries.value.length > 0
        ? { label: t('statusMonitor.common.totalLabel'), count: skillEntries.value.length }
        : null;
    case 'token':
      if (props.activeBackendKind === 'codex') return null;
      return tokenUsage.value && !tokenUsageContextOnly.value
        ? { label: t('statusMonitor.token.totalTokens'), count: tokenUsage.value.tokens.total ?? (tokenUsage.value.tokens.input + tokenUsage.value.tokens.output + tokenUsage.value.tokens.reasoning) }
        : null;
    case 'mc':
      return props.magicContextWorkers?.length
        ? { label: t('statusMonitor.common.totalLabel'), count: props.magicContextWorkers.length }
        : null;
    case 'acp':
      return null;
    default:
      return null;
  }
});

function formatTokenCount(count: number): string {
  return count.toLocaleString();
}

function formatPercent(value: number, total: number): string {
  if (total <= 0) return '0%';
  return `${Math.round((value / total) * 100)}%`;
}

/**
 * Usage progress for the token tab. Kimi Web reports context occupancy
 * directly (`contextTokens` / `maxContextTokens` from `agent.status.updated`),
 * which is the honest bar; the other backends approximate it with the usage
 * total over the model context limit.
 */
const tokenUsagePercent = computed(() => {
  if (isKimiWebBackend.value) {
    return formatPercent(tokenContextUsed.value, tokenContextLimit.value);
  }
  if (!tokenUsage.value) return '0%';
  const total =
    tokenUsage.value.tokens.total ??
    (tokenUsage.value.tokens.input +
      tokenUsage.value.tokens.output +
      tokenUsage.value.tokens.reasoning);
  return formatPercent(total, tokenContextLimit.value);
});

const kimiCapabilitiesText = computed(() => {
  const capabilities = kimiMeta.value?.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    return t('statusMonitor.server.unavailable');
  }
  const enabled = Object.entries(capabilities)
    .filter(([, value]) => value === true)
    .map(([name]) => name);
  return enabled.length > 0 ? enabled.join(', ') : t('statusMonitor.server.none');
});

/**
 * Kimi Server rows render once the live meta/auth envelope has landed, so a
 * rejected bridge `/healthz` no longer swallows them behind the generic
 * "no server status information" state.
 */
const kimiStatusLoaded = computed(() => kimiMeta.value !== null || kimiAuth.value !== null);

/**
 * Server-tab Version value. For kimi-web the adapter's `getGlobalHealth()`
 * already answers from `meta.server_version` (D3), so `serverHealth.version`
 * IS the kimi version; the live meta is the last-resort source when no health
 * call answered. Other backends keep reading `serverHealth` alone.
 */
const serverVersionText = computed(() => {
  if (serverHealth.value) return serverHealth.value.version;
  if (isKimiWebBackend.value) return kimiMeta.value?.server_version ?? '';
  return '';
});

const kimiModelsReadyText = computed(() => {
  if (kimiAuth.value?.models_ready === true) return t('statusMonitor.server.modelsReadyYes');
  if (kimiAuth.value?.models_ready === false) return t('statusMonitor.server.modelsReadyNo');
  return t('statusMonitor.server.unavailable');
});

const kimiModelsReadyDotClass = computed(() => {
  if (kimiAuth.value?.models_ready === true) return 'status-dot-success';
  if (kimiAuth.value?.models_ready === false) return 'status-dot-error';
  return 'status-dot-muted';
});

</script>

<template>
  <div
    v-if="open"
    ref="popoverRef"
    class="status-monitor-popover"
  >
    <header class="status-monitor-header">
      <div class="status-monitor-header-main">
        <div class="status-monitor-title">{{ $t('statusMonitor.title') }}</div>
      </div>
      <button
        type="button"
        class="status-monitor-close-button"
        :aria-label="$t('statusMonitor.close')"
        @click="$emit('close')"
      >
        <Icon icon="lucide:x" :width="14" :height="14" />
      </button>
    </header>

    <div ref="tablistRef" class="status-monitor-tabs" role="tablist" :aria-label="$t('statusMonitor.title')">
      <button
        v-for="(tab, index) in tabs"
        :key="tab.id"
        type="button"
        role="tab"
        :id="`status-monitor-tab-${tab.id}`"
        class="status-monitor-tab"
        :class="{ 'is-active': activeTab === tab.id }"
        :aria-selected="activeTab === tab.id"
        aria-controls="status-monitor-tabpanel"
        :tabindex="activeTab === tab.id ? 0 : -1"
        @click="activeTab = tab.id"
        @keydown="handleTabKeydown($event, index)"
      >
        {{ $t(tab.labelKey) }}
      </button>
    </div>

    <div
      id="status-monitor-tabpanel"
      class="status-monitor-body"
      role="tabpanel"
      :aria-labelledby="`status-monitor-tab-${activeTab}`"
      tabindex="0"
    >
      <div v-if="currentTotalInfo" class="status-monitor-actions">
          <span class="status-monitor-summary-label">{{ currentTotalInfo.label }}</span>
          <span class="status-monitor-summary-value">{{ currentTotalInfo.count }}</span>
        </div>

        <div v-if="errorMessage && activeTab !== 'acp'" class="status-monitor-feedback is-error">
          <span>{{ errorMessage }}</span>
          <button type="button" class="retry-button" @click="refresh">
            {{ $t('statusMonitor.retry') }}
          </button>
        </div>

        <!-- Server Tab -->
        <div v-if="activeTab === 'server'" class="status-monitor-content">
          <div v-if="loading && !serverHealth && !kimiStatusLoaded" class="status-monitor-empty">
            {{ $t('statusMonitor.loading') }}
          </div>
          <div v-else-if="!serverHealth && !kimiStatusLoaded" class="status-monitor-empty">
            {{ $t('statusMonitor.server.noData') }}
          </div>
          <div v-else class="status-monitor-list">
            <template v-if="serverHealth">
              <div class="status-monitor-row">
                <div class="status-monitor-row-main">
                  <span class="status-dot" :class="serverHealth.healthy ? 'status-dot-success' : 'status-dot-error'" />
                  <span class="status-monitor-name">{{ $t('statusMonitor.server.status') }}</span>
                </div>
                <span class="status-monitor-meta">
                  {{ serverHealth.healthy ? $t('statusMonitor.server.healthy') : $t('statusMonitor.server.unhealthy') }}
                </span>
              </div>
            </template>
            <div v-if="serverHealth || serverVersionText" class="status-monitor-row">
              <div class="status-monitor-row-main">
                <span class="status-monitor-name">{{ $t('statusMonitor.server.version') }}</span>
              </div>
              <span class="status-monitor-meta">{{ serverVersionText }}</span>
            </div>
            <template v-if="activeBackendKind === 'kimi-web'">
              <div class="status-monitor-row is-capabilities">
                <div class="status-monitor-row-main">
                  <span class="status-monitor-name">{{ $t('statusMonitor.server.capabilities') }}</span>
                </div>
                <span class="status-monitor-meta">{{ kimiCapabilitiesText }}</span>
              </div>
              <div class="status-monitor-row">
                <div class="status-monitor-row-main">
                  <span class="status-dot" :class="kimiModelsReadyDotClass" />
                  <span class="status-monitor-name">{{ $t('statusMonitor.server.modelsReady') }}</span>
                </div>
                <span class="status-monitor-meta">{{ kimiModelsReadyText }}</span>
              </div>
            </template>
          </div>
        </div>

        <!-- MCP Tab -->
        <div v-if="activeTab === 'mcp'" class="status-monitor-content">
          <div v-if="loading && !mcpData" class="status-monitor-empty">
            {{ $t('statusMonitor.loading') }}
          </div>
          <div v-else-if="mcpUnsupported && mcpEntries.length === 0" class="status-monitor-empty">
            {{ mcpUnsupportedText }}
          </div>
          <div v-else-if="mcpEntries.length === 0" class="status-monitor-empty">
            {{ $t('statusMonitor.mcp.noData') }}
          </div>
          <div v-else class="status-monitor-list">
            <div
              v-for="item in mcpEntries"
              :key="item.name"
              class="status-monitor-row"
            >
              <div class="status-monitor-row-main">
                <span class="status-dot" :class="mcpStatusClass(item.status)" />
                <span class="status-monitor-name">{{ item.name }}</span>
              </div>
              <div class="status-monitor-row-actions">
                <div class="status-monitor-meta-column">
                  <span class="status-monitor-meta status-monitor-mcp-status">
                    {{ mcpStatusText(item.status) }}
                  </span>
                  <span v-if="'error' in item && item.error" class="status-monitor-error">
                    {{ item.error }}
                  </span>
                </div>
                <label
                  v-if="typeof backend().updateMcp === 'function'"
                  class="toggle-switch"
                  :title="item.status === 'disabled' ? $t('statusMonitor.mcp.enable') : $t('statusMonitor.mcp.disable')"
                >
                  <input
                    type="checkbox"
                    class="toggle-input"
                    :aria-label="
                      item.status === 'disabled'
                        ? $t('statusMonitor.mcp.enable')
                        : $t('statusMonitor.mcp.disable')
                    "
                    :checked="item.status !== 'disabled'"
                    :disabled="togglingMcp === item.name"
                    @change="handleMcpToggle(item.name, item.status)"
                  />
                  <span class="toggle-track" />
                </label>
              </div>
            </div>
          </div>
        </div>

        <!-- LSP Tab -->
        <div v-if="activeTab === 'lsp'" class="status-monitor-content">
          <div v-if="loading && !lspData" class="status-monitor-empty">
            {{ $t('statusMonitor.loading') }}
          </div>
          <div v-else-if="lspUnsupported && (lspData || []).length === 0" class="status-monitor-empty">
            {{ lspUnsupportedText }}
          </div>
          <div v-else-if="(lspData || []).length === 0" class="status-monitor-empty">
            {{ $t('statusMonitor.lsp.noData') }}
          </div>
          <div v-else class="status-monitor-list">
            <div
              v-for="item in lspData"
              :key="item.id"
              class="status-monitor-row"
            >
              <div class="status-monitor-row-main">
                <span class="status-dot" :class="lspStatusClass(item.status)" />
                <span class="status-monitor-name">{{ item.name || item.id }}</span>
              </div>
              <div class="status-monitor-meta-column">
                <span class="status-monitor-meta">{{ item.root }}</span>
                <span class="status-monitor-meta" :class="item.status === 'error' ? 'is-error' : ''">
                  {{ item.status === 'connected' ? $t('statusMonitor.lsp.connected') : $t('statusMonitor.lsp.error') }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Plugins Tab -->
        <div v-if="activeTab === 'plugins'" class="status-monitor-content">
          <KimiWebPluginManager v-if="isKimiWebBackend && kimiWebPluginsClient" :client="kimiWebPluginsClient" />
          <div v-else-if="loading && !configData" class="status-monitor-empty">
            {{ $t('statusMonitor.loading') }}
          </div>
          <div v-else-if="pluginUnsupported" class="status-monitor-empty">
            {{ pluginUnsupportedText }}
          </div>
          <div v-else-if="activeBackendKind === 'codex'" class="status-monitor-summary-grid">
            <div class="status-monitor-summary-chip">
              <span class="status-monitor-summary-label">{{ $t('statusMonitor.plugins.marketplaces') }}</span>
              <span class="status-monitor-summary-value">{{ pluginStats.marketplaces }}</span>
            </div>
            <div class="status-monitor-summary-chip">
              <span class="status-monitor-summary-label">{{ $t('statusMonitor.plugins.total') }}</span>
              <span class="status-monitor-summary-value">{{ pluginStats.total }}</span>
            </div>
            <div class="status-monitor-summary-chip">
              <span class="status-monitor-summary-label">{{ $t('statusMonitor.plugins.accessible') }}</span>
              <span class="status-monitor-summary-value">{{ pluginStats.accessible }}</span>
            </div>
            <div class="status-monitor-summary-chip">
              <span class="status-monitor-summary-label">{{ $t('statusMonitor.plugins.enabled') }}</span>
              <span class="status-monitor-summary-value">{{ pluginStats.enabled }}</span>
            </div>
            <div class="status-monitor-summary-chip">
              <span class="status-monitor-summary-label">{{ $t('statusMonitor.plugins.installed') }}</span>
              <span class="status-monitor-summary-value">{{ pluginStats.installed }}</span>
            </div>
          </div>
          <div v-if="!pluginUnsupported && pluginEntries.length > 0" class="status-monitor-list">
            <div v-if="hiddenPluginCount > 0" class="status-monitor-summary">
              {{ $t('statusMonitor.plugins.hiddenUnavailable', { count: hiddenPluginCount }) }}
            </div>
            <div
              v-for="plugin in pluginEntries"
              :key="plugin.id"
              class="status-monitor-row"
            >
              <div class="status-monitor-row-main">
                <span class="status-dot" :class="plugin.enabled ? 'status-dot-success' : plugin.installed ? 'status-dot-warning' : 'status-dot-muted'" />
                <span class="status-monitor-name">{{ plugin.name }}</span>
              </div>
              <div v-if="!plugin.enabled" class="status-monitor-meta-column">
                <span class="status-monitor-meta">
                  {{ plugin.installed ? $t('codexPanel.appDisabled') : $t('codexPanel.appNotAccessible') }}
                </span>
              </div>
            </div>
          </div>
          <div v-else-if="!pluginUnsupported && hiddenPluginCount > 0" class="status-monitor-empty">
            {{ $t('statusMonitor.plugins.hiddenUnavailable', { count: hiddenPluginCount }) }}
          </div>
          <div v-else-if="!pluginUnsupported" class="status-monitor-empty">
            {{ $t('statusMonitor.plugins.noData') }}
          </div>
        </div>

        <!-- Skills Tab -->
        <div v-if="activeTab === 'skills'" class="status-monitor-content">
          <div v-if="loading && skillEntries.length === 0" class="status-monitor-empty">
            {{ $t('statusMonitor.loading') }}
          </div>
          <div v-else-if="skillUnsupported && skillEntries.length === 0" class="status-monitor-empty">
            {{ skillUnsupportedText }}
          </div>
          <div v-else-if="skillEntries.length === 0" class="status-monitor-empty">
            {{ $t('statusMonitor.skills.noData') }}
          </div>
          <div v-else class="status-monitor-list">
            <div
              v-for="skill in skillEntries"
              :key="skill.name"
              class="status-monitor-row"
            >
              <div class="status-monitor-row-main">
                <span
                  class="status-dot"
                  :class="skill.enabled === false ? 'status-dot-muted' : 'status-dot-success'"
                />
                <span class="status-monitor-name">{{ skill.name }}</span>
              </div>
              <div v-if="skill.enabled !== undefined && typeof backend().updateSkill === 'function'" class="status-monitor-row-actions">
                <label
                  class="toggle-switch"
                  :title="skill.enabled ? $t('statusMonitor.skills.disable') : $t('statusMonitor.skills.enable')"
                >
                  <input
                    type="checkbox"
                    class="toggle-input"
                    :checked="skill.enabled"
                    :disabled="togglingSkill === skill.name"
                    @change="handleSkillToggle(skill.name, skill.enabled, skill.path)"
                  />
                  <span class="toggle-track" />
                </label>
              </div>
            </div>
          </div>
        </div>

        <!-- Token Tab -->
        <div v-if="activeTab === 'token'" class="status-monitor-content">
          <section v-if="activeBackendKind === 'codex'" class="codex-session-usage" :aria-label="codexSessionCopy.title">
            <h3 class="codex-session-title">{{ codexSessionCopy.title }}</h3>
            <div v-if="!sessionId" class="status-monitor-empty">{{ $t('statusMonitor.token.noSession') }}</div>
            <div v-else-if="!codexSessionUsage" class="status-monitor-empty">{{ codexSessionCopy.unavailable }}</div>
            <template v-else>
              <div v-if="codexContextPercent !== null" class="token-usage-bar-row">
                <div class="codex-context-caption"><span>{{ codexSessionCopy.context }}</span><span>{{ codexContextPercent }}%</span></div>
                <div class="token-usage-track" role="meter" :aria-label="codexSessionCopy.context" :aria-valuenow="Math.min(codexContextPercent, 100)" aria-valuemin="0" aria-valuemax="100">
                  <div class="token-usage-fill" :style="{ width: `${Math.min(codexContextPercent, 100)}%` }" />
                </div>
              </div>
              <div class="status-monitor-row token-row"><span class="token-label">{{ codexSessionCopy.window }}</span><span class="token-value">{{ codexSessionUsage.modelContextWindow ? formatTokenCount(codexSessionUsage.modelContextWindow) : '—' }}</span></div>
              <div class="status-monitor-row token-row"><span class="token-label">{{ codexSessionCopy.total }}</span><span class="token-value">{{ formatTokenCount(codexSessionUsage.total.totalTokens) }}</span></div>
              <div class="status-monitor-row token-row"><span class="token-label">{{ codexSessionCopy.input }}</span><span class="token-value">{{ formatTokenCount(codexSessionUsage.total.inputTokens) }}</span></div>
              <div class="status-monitor-row token-row"><span class="token-label">{{ codexSessionCopy.output }}</span><span class="token-value">{{ formatTokenCount(codexSessionUsage.total.outputTokens) }}</span></div>
              <div class="status-monitor-row token-row"><span class="token-label">{{ codexSessionCopy.reasoning }}</span><span class="token-value">{{ formatTokenCount(codexSessionUsage.total.reasoningOutputTokens) }}</span></div>
              <div class="status-monitor-row token-row"><span class="token-label">{{ codexSessionCopy.cache }}</span><span class="token-value">{{ formatTokenCount(codexSessionUsage.total.cachedInputTokens) }} / {{ formatTokenCount(codexSessionUsage.total.cacheWriteInputTokens) }}</span></div>
              <div class="status-monitor-row token-row"><span class="token-label">{{ codexSessionCopy.latest }}</span><span class="token-value">{{ formatTokenCount(codexSessionUsage.last.totalTokens) }}</span></div>
              <div class="status-monitor-row token-row"><span class="token-label">{{ codexSessionCopy.context }}</span><span class="token-value">{{ formatTokenCount(codexSessionUsage.last.inputTokens) }} / {{ codexSessionUsage.modelContextWindow ? formatTokenCount(codexSessionUsage.modelContextWindow) : '—' }}</span></div>
            </template>
          </section>
          <div v-else-if="!sessionId" class="status-monitor-empty">
            {{ $t('statusMonitor.token.noSession') }}
          </div>
          <div v-else-if="tokenLoading && !tokenUsage" class="status-monitor-empty">
            {{ $t('statusMonitor.loading') }}
          </div>
          <div v-else-if="!tokenUsage" class="status-monitor-empty">
            {{ $t('statusMonitor.token.noData') }}
          </div>
          <div v-else class="status-monitor-list">
            <!-- Usage percent bar at top -->
            <div v-if="tokenContextLimit > 0" class="token-usage-bar-row">
              <div class="token-usage-track">
                <div
                  class="token-usage-fill"
                  :style="{ width: tokenUsagePercent }"
                />
              </div>
              <span class="token-usage-percent">
                {{ tokenUsagePercent }}
              </span>
            </div>
            <div class="status-monitor-row token-row">
              <span class="token-label">{{ $t('statusMonitor.token.model') }}</span>
              <span class="token-value">{{ tokenModelName || '-' }}</span>
            </div>
            <div class="status-monitor-row token-row">
              <span class="token-label">{{ $t('statusMonitor.token.contextLimit') }}</span>
              <span class="token-value">{{ tokenContextLimit > 0 ? formatTokenCount(tokenContextLimit) : '-' }}</span>
            </div>
            <div v-if="isKimiWebBackend" class="status-monitor-row token-row">
              <span class="token-label">{{ locale.startsWith('zh') ? '上下文已使用' : 'Context used' }}</span>
              <span class="token-value">{{ tokenContextAvailable ? formatTokenCount(tokenContextUsed) : '-' }}</span>
            </div>
            <div v-if="tokenUsageContextOnly" class="status-monitor-row token-row">
              <span class="token-label token-context-note">{{ $t('statusMonitor.token.contextOnlyNote') }}</span>
            </div>
            <template v-else>
              <div class="status-monitor-row token-row">
                <span class="token-label">{{ $t('statusMonitor.token.inputTokens') }}</span>
                <span class="token-value">{{ formatTokenCount(tokenUsage.tokens.input) }}</span>
              </div>
              <div class="status-monitor-row token-row">
                <span class="token-label">{{ $t('statusMonitor.token.outputTokens') }}</span>
                <span class="token-value">{{ formatTokenCount(tokenUsage.tokens.output) }}</span>
              </div>
              <div v-if="!isKimiWebBackend" class="status-monitor-row token-row">
                <span class="token-label">{{ $t('statusMonitor.token.reasoningTokens') }}</span>
                <span class="token-value">{{ formatTokenCount(tokenUsage.tokens.reasoning) }}</span>
              </div>
              <div v-if="tokenUsage.tokens.cache" class="status-monitor-row token-row">
                <span class="token-label">{{ $t('statusMonitor.token.cacheTokens') }}</span>
                <span class="token-value">{{ formatTokenCount(tokenUsage.tokens.cache.read) }} / {{ formatTokenCount(tokenUsage.tokens.cache.write) }}</span>
              </div>
            </template>
            <div class="status-monitor-row token-row">
              <span class="token-label">{{ $t('statusMonitor.token.userMessages') }}</span>
              <span class="token-value">{{ tokenUserMessages }}</span>
            </div>
            <div class="status-monitor-row token-row">
              <span class="token-label">{{ $t('statusMonitor.token.assistantMessages') }}</span>
              <span class="token-value">{{ tokenAssistantMessages }}</span>
            </div>
          </div>
          <CodexAccountTokenUsage v-if="activeBackendKind === 'codex'" ref="accountUsageRef" :api="codexApi" :initial-view="initialUsageView" />
          <section v-if="activeBackendKind === 'codex'" class="codex-account-status">
            <div v-if="codexApi.status.value !== 'connected'" class="status-monitor-empty">
              {{ $t('statusMonitor.codex.notConnected') }}
            </div>
            <div v-else class="status-monitor-list">
              <div v-if="codexFiveHourRateLimit || codexWeeklyRateLimit" class="codex-rate-limits">
                <h3>{{ $t('codexPanel.rateLimits') }}</h3>
                <div v-if="codexFiveHourRateLimit" class="token-usage-bar-row codex-usage-bar">
                  <div class="codex-context-caption"><span>{{ $t('statusMonitor.codex.rateLimitFiveHourUsed') }}</span><span>{{ rateLimitPercent(codexFiveHourRateLimit.usedPercent) }}%</span></div>
                  <div class="token-usage-track" role="meter" :aria-label="$t('statusMonitor.codex.rateLimitFiveHourUsed')" :aria-valuenow="rateLimitPercent(codexFiveHourRateLimit.usedPercent)" aria-valuemin="0" aria-valuemax="100">
                    <div class="token-usage-fill" :style="{ width: `${rateLimitPercent(codexFiveHourRateLimit.usedPercent)}%` }" />
                  </div>
                </div>
                <div v-if="codexWeeklyRateLimit" class="token-usage-bar-row codex-usage-bar">
                  <div class="codex-context-caption"><span>{{ $t('statusMonitor.codex.rateLimitUsed') }}</span><span>{{ rateLimitPercent(codexWeeklyRateLimit.usedPercent) }}%</span></div>
                  <div class="token-usage-track" role="meter" :aria-label="$t('statusMonitor.codex.rateLimitUsed')" :aria-valuenow="rateLimitPercent(codexWeeklyRateLimit.usedPercent)" aria-valuemin="0" aria-valuemax="100">
                    <div class="token-usage-fill" :style="{ width: `${rateLimitPercent(codexWeeklyRateLimit.usedPercent)}%` }" />
                  </div>
                </div>
              </div>

              <div class="status-monitor-row">
                <div class="status-monitor-row-main">
                  <span class="status-dot" :class="codexApi.account.value ? 'status-dot-success' : 'status-dot-warning'" />
                  <span class="status-monitor-name">{{ $t('statusMonitor.codex.account') }}</span>
                </div>
                <div class="status-monitor-row-actions">
                  <div class="status-monitor-meta-column">
                    <span class="status-monitor-meta">
                      {{ codexApi.account.value?.type || $t('statusMonitor.codex.notLoggedIn') }}
                    </span>
                    <span v-if="codexPlanType" class="status-monitor-meta">
                      {{ codexPlanType }}
                    </span>
                  </div>
                  <button
                    v-if="codexApi.account.value"
                    type="button"
                    class="status-monitor-action-button"
                    :disabled="codexApi.loginPending.value"
                    @click="handleCodexLogout"
                  >
                    {{ $t('statusMonitor.codex.logout') }}
                  </button>
                </div>
              </div>

              <div v-if="!codexApi.account.value" class="codex-login-card">
                <input
                  v-model="codexApiKeyInput"
                  class="codex-login-input"
                  type="password"
                  :placeholder="$t('codexPanel.apiKeyPlaceholder')"
                  @keydown.enter="handleCodexApiKeyLogin"
                />
                <div class="codex-login-actions">
                  <button
                    type="button"
                    class="status-monitor-action-button"
                    :disabled="codexApi.loginPending.value || !codexApiKeyInput.trim()"
                    @click="handleCodexApiKeyLogin"
                  >
                    {{ $t('statusMonitor.codex.loginApiKey') }}
                  </button>
                  <button
                    type="button"
                    class="status-monitor-action-button"
                    :disabled="codexApi.loginPending.value"
                    @click="codexApi.loginWithChatgpt"
                  >
                    {{ $t('statusMonitor.codex.loginChatgpt') }}
                  </button>
                  <button
                    type="button"
                    class="status-monitor-action-button"
                    :disabled="codexApi.loginPending.value"
                    @click="codexApi.loginWithDeviceCode"
                  >
                    {{ $t('statusMonitor.codex.loginDeviceCode') }}
                  </button>
                </div>
                <div v-if="codexApi.deviceCodeInfo.value" class="status-monitor-meta-column codex-device-code">
                  <span class="status-monitor-meta">{{ codexApi.deviceCodeInfo.value.verificationUrl }}</span>
                  <span class="status-monitor-name">{{ codexApi.deviceCodeInfo.value.userCode }}</span>
                </div>
                <div v-if="codexApi.loginError.value" class="status-monitor-error">
                  {{ codexApi.loginError.value }}
                </div>
              </div>
            </div>
          </section>
          <KimiAccountUsage v-if="isKimiWebBackend" ref="kimiAccountUsageRef" />
        </div>

        <div v-if="activeTab === 'acp'" class="status-monitor-content">
          <AcpManagerPanel ref="acpManagerRef" />
        </div>

        <!-- Magic Context Tab -->
        <div v-if="activeTab === 'mc' && activeBackendKind === 'opencode'" class="status-monitor-content">
          <div v-if="!magicContextWorkers?.length" class="status-monitor-empty">
            {{ $t('statusMonitor.mc.noData') }}
          </div>
          <div v-else class="status-monitor-list">
            <div
              v-for="worker in magicContextWorkers"
              :key="worker.sessionId"
              class="status-monitor-row"
            >
              <div class="status-monitor-row-main">
                <span class="status-dot" :class="magicContextStatusClass(worker.status)" />
                <span class="status-monitor-name">{{ worker.name }}</span>
              </div>
              <span class="status-monitor-meta">
                {{ magicContextStatusText(worker.status) }}
              </span>
            </div>
          </div>
        </div>

    </div>

    <div class="status-monitor-footer">
      <button
        type="button"
        class="refresh-button"
        :disabled="loading"
        :title="loading ? $t('statusMonitor.refreshing') : $t('statusMonitor.refresh')"
        @click="handleRefresh"
      >
        <Icon icon="lucide:refresh-cw" :width="14" :height="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.status-monitor-popover {
  position: fixed;
  top: 48px;
  right: 12px;
  width: min(420px, calc(100vw - 24px));
  max-height: min(480px, calc(100vh - 180px));
  z-index: 1000;
  display: flex;
  flex-direction: column;
  background: var(--theme-modal-bg, rgba(15, 23, 42, 0.98));
  border: 1px solid var(--theme-modal-border, #334155);
  color: var(--theme-modal-text, #e2e8f0);
  border-radius: 12px;
  box-shadow: 0 20px 48px rgba(2, 6, 23, 0.55);
  overflow: hidden;
}

.status-monitor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--theme-modal-border, #334155);
}

.status-monitor-header-main {
  display: flex;
  align-items: center;
  gap: 10px;
}

.status-monitor-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--theme-modal-text, #e2e8f0);
  letter-spacing: 0.02em;
}

.status-monitor-close-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--theme-modal-text, #94a3b8);
  background: var(--theme-modal-control-bg, transparent);
  border: 1px solid var(--theme-modal-border, #334155);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.status-monitor-close-button:hover {
  color: var(--theme-modal-text, #e2e8f0);
  background: var(--theme-modal-active-bg, rgba(148, 163, 184, 0.15));
}

.status-monitor-body {
  flex: 1;
  min-height: 0;
  padding: 12px 16px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-sizing: border-box;
}

.status-monitor-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px;
  margin: 12px 16px 0;
  background: var(--theme-card-bg, var(--theme-modal-control-bg, rgba(30, 41, 59, 0.55)));
  border: 1px solid var(--theme-card-border, var(--theme-modal-border, rgba(148, 163, 184, 0.15)));
  border-radius: 8px;
  width: calc(100% - 32px);
  box-sizing: border-box;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
  scrollbar-color: var(--theme-modal-border, rgba(148, 163, 184, 0.3)) transparent;
  flex-shrink: 0;
}

.status-monitor-tabs::-webkit-scrollbar {
  height: 4px;
}

.status-monitor-tabs::-webkit-scrollbar-track {
  background: transparent;
}

.status-monitor-tabs::-webkit-scrollbar-thumb {
  background: var(--theme-modal-border, rgba(148, 163, 184, 0.3));
  border-radius: 999px;
}

.status-monitor-tab {
  flex: 0 0 auto;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 500;
  color: var(--theme-tab-text, var(--theme-modal-text-muted, #94a3b8));
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background: var(--theme-tab-bg, transparent);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
  white-space: nowrap;
}

.status-monitor-tab:hover {
  color: var(--theme-tab-active-text, var(--theme-text-primary, #e2e8f0));
  background: var(--theme-tab-hover-bg, var(--theme-modal-active-bg, rgba(148, 163, 184, 0.12)));
}

.status-monitor-tab.is-active {
  color: var(--theme-tab-active-text, var(--theme-text-primary, #e2e8f0));
  background: var(--theme-tab-active-bg, var(--theme-modal-active-bg, rgba(30, 64, 175, 0.45)));
}

.status-monitor-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-right: 12px;
}

.status-monitor-summary-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--theme-modal-text, #e2e8f0);
}

.status-monitor-summary-value {
  font-size: 13px;
  font-weight: 500;
  color: var(--theme-modal-text-muted, #94a3b8);
}

.status-monitor-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 5px 16px;
  border-top: 1px solid var(--theme-modal-border, rgba(148, 163, 184, 0.15));
  background: var(--theme-modal-bg, rgba(15, 23, 42, 0.98));
}

.refresh-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  margin-right: -4px;
  font-size: 12px;
  color: var(--theme-modal-text-muted, #94a3b8);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}

.refresh-button:hover:not(:disabled) {
  color: var(--theme-modal-text, #e2e8f0);
  background: var(--theme-modal-active-bg, rgba(148, 163, 184, 0.12));
}

.refresh-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.status-monitor-feedback {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  font-size: 12px;
  border-radius: 8px;
  min-width: 0;
}

.status-monitor-feedback.is-error {
  color: var(--theme-text-danger, #fecaca);
  background: var(--theme-surface-danger, rgba(127, 29, 29, 0.35));
  border: 1px solid color-mix(in srgb, var(--theme-status-danger, #fca5a5) 35%, transparent);
}

.retry-button {
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--theme-text-danger, #fecaca);
  background: var(--theme-surface-danger-soft, rgba(248, 113, 113, 0.2));
  border: 1px solid color-mix(in srgb, var(--theme-status-danger, #fca5a5) 45%, transparent);
  border-radius: 5px;
  cursor: pointer;
}

.retry-button:hover {
  background: color-mix(in srgb, var(--theme-status-danger, #fca5a5) 30%, transparent);
}

.status-monitor-action-button {
  padding: 5px 8px;
  border: 1px solid var(--theme-modal-border, rgba(148, 163, 184, 0.24));
  border-radius: 6px;
  background: var(--theme-modal-control-bg, rgba(30, 41, 59, 0.55));
  color: var(--theme-modal-text, #e2e8f0);
  font-size: 11px;
  cursor: pointer;
}

.status-monitor-action-button:hover:not(:disabled) {
  background: var(--theme-modal-active-bg, rgba(148, 163, 184, 0.15));
}

.status-monitor-action-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.codex-login-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--theme-list-row-border, var(--theme-modal-border, rgba(148, 163, 184, 0.12)));
  border-radius: 8px;
  background: var(--theme-list-row-bg, var(--theme-modal-control-bg, rgba(30, 41, 59, 0.55)));
}

.codex-login-input {
  width: 100%;
  min-width: 0;
  padding: 7px 8px;
  border: 1px solid var(--theme-modal-border, rgba(148, 163, 184, 0.24));
  border-radius: 6px;
  background: var(--theme-input-bg, rgba(15, 23, 42, 0.8));
  color: var(--theme-modal-text, #e2e8f0);
  font-size: 12px;
  outline: none;
  appearance: none;
}

.codex-login-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.codex-device-code {
  align-items: flex-start;
}

.status-monitor-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.status-monitor-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.status-monitor-summary-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 10px;
}

.status-monitor-summary-chip {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--theme-list-row-bg, var(--theme-modal-control-bg, rgba(30, 41, 59, 0.55)));
  border: 1px solid var(--theme-list-row-border, var(--theme-modal-border, rgba(148, 163, 184, 0.12)));
  border-radius: 8px;
}

.status-monitor-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--theme-list-row-bg, var(--theme-modal-control-bg, rgba(30, 41, 59, 0.55)));
  border: 1px solid var(--theme-list-row-border, var(--theme-modal-border, rgba(148, 163, 184, 0.12)));
  border-radius: 8px;
  min-width: 0;
}

.status-monitor-row-main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.status-monitor-row-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
  min-width: 0;
}

.status-monitor-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--theme-list-row-text, var(--theme-text-primary, #e2e8f0));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.status-monitor-meta-column {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  min-width: 0;
}

.status-monitor-meta {
  font-size: 12px;
  color: var(--theme-list-row-text-muted, var(--theme-modal-text-muted, #94a3b8));
}

.status-monitor-row.is-capabilities {
  align-items: flex-start;
  flex-wrap: wrap;
}

.status-monitor-row.is-capabilities .status-monitor-meta {
  flex: 1 1 220px;
  min-width: 0;
  overflow-wrap: anywhere;
  line-height: 1.5;
}

.status-monitor-meta.is-error {
  color: var(--theme-text-danger, #fca5a5);
}

.status-monitor-mcp-status {
  white-space: nowrap;
}

.status-monitor-error {
  font-size: 11px;
  color: var(--theme-text-danger, #fca5a5);
  max-width: 280px;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toggle-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  cursor: pointer;
}

.toggle-input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-track {
  width: 36px;
  height: 20px;
  background: var(--theme-toggle-track, var(--theme-modal-border, #334155));
  border-radius: 10px;
  position: relative;
  transition: background 0.2s;
}

.toggle-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: var(--theme-toggle-thumb, var(--theme-status-neutral, #94a3b8));
  border-radius: 50%;
  transition:
    transform 0.2s,
    background 0.2s;
}

.toggle-input:checked + .toggle-track {
  background: var(--theme-toggle-active-track, var(--theme-modal-accent, #3b82f6));
}

.toggle-input:checked + .toggle-track::after {
  background: var(--theme-toggle-active-thumb, var(--theme-text-inverse, #ffffff));
  transform: translateX(16px);
}

.toggle-input:focus-visible + .toggle-track {
  outline: 2px solid var(--theme-focus-ring, var(--theme-modal-accent, #3b82f6));
  outline-offset: 2px;
  box-shadow:
    0 0 0 2px var(--theme-modal-bg, #0f172a),
    0 0 0 4px var(--theme-accent-primary, #60a5fa);
}

.toggle-input:disabled + .toggle-track {
  opacity: 0.5;
  cursor: not-allowed;
}

.status-monitor-summary {
  font-size: 12px;
  font-weight: 500;
  color: var(--theme-modal-text-muted, #94a3b8);
}

.status-monitor-empty {
  padding: 32px 16px;
  font-size: 13px;
  color: var(--theme-empty-state-text, var(--theme-modal-text-muted, #94a3b8));
  text-align: center;
}

.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 9999px;
  flex-shrink: 0;
  align-self: center;
}

.status-dot-success {
  background: var(--theme-status-success, #86efac);
}

.status-dot-error {
  background: var(--theme-status-danger, #fca5a5);
}

.status-dot-warning {
  background: var(--theme-status-warning, #fcd34d);
}

.status-dot-muted {
  background: var(--theme-status-neutral, #94a3b8);
}

.token-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 12px;
  min-width: 0;
  background: transparent;
  border: none;
  border-radius: 0;
  border-bottom: 1px solid var(--theme-modal-border, rgba(148, 163, 184, 0.12));
}

.codex-session-title { margin: 0; padding: 8px 12px; font-size: 14px; font-weight: 600; color: var(--theme-modal-text, #e2e8f0); }
.codex-context-caption { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--theme-modal-text-muted, #94a3b8); font-variant-numeric: tabular-nums; }
.codex-session-usage .token-label { flex-shrink: 1; overflow-wrap: anywhere; }
.codex-account-status { border-top: 1px solid var(--theme-modal-border, rgba(148, 163, 184, 0.12)); margin-top: 16px; padding-top: 8px; }
.codex-rate-limits h3 { margin: 0; padding: 8px 12px; font-size: 13px; font-weight: 600; }

.token-row:last-child {
  border-bottom: none;
}

.token-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--theme-modal-text-muted, #94a3b8);
  flex-shrink: 0;
}

.token-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--theme-modal-text, #e2e8f0);
  text-align: right;
  word-break: break-all;
}

.token-context-note {
  flex-shrink: 1;
  white-space: normal;
  overflow-wrap: anywhere;
}

.token-usage-bar-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--theme-modal-border, rgba(148, 163, 184, 0.12));
}

.codex-usage-bar {
  border-bottom: none;
}

.token-usage-track {
  height: 6px;
  background: var(--theme-modal-control-bg, rgba(30, 41, 59, 0.55));
  border-radius: 999px;
  overflow: hidden;
}

.token-usage-fill {
  height: 100%;
  background: var(--theme-modal-accent, #3b82f6);
  border-radius: 999px;
  transition: width 0.3s ease;
  min-width: 0;
}

.token-usage-percent {
  font-size: 12px;
  font-weight: 500;
  color: var(--theme-modal-text-muted, #94a3b8);
  text-align: center;
}

@media (prefers-reduced-motion: reduce) {
  .status-monitor-close-button,
  .status-monitor-tab,
  .refresh-button,
  .toggle-track,
  .toggle-track::after,
  .token-usage-fill {
    transition: none;
  }
}
</style>
