<script setup lang="ts">
import { ref, watch, computed, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { getActiveBackendAdapter } from '../backends/registry';
import { useMessages } from '../composables/useMessages';
import type { useCodexApi } from '../composables/useCodexApi';
import type { MessageUsage } from '../types/message';
import type { MessageInfo } from '../types/sse';

type CodexApi = ReturnType<typeof useCodexApi>;

const props = defineProps<{ open: boolean; sessionId?: string; codexApi: CodexApi }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const popoverRef = ref<HTMLDivElement | null>(null);
const msg = useMessages();
const codexApi = props.codexApi;

function backend() {
  return getActiveBackendAdapter();
}

function requireBackendMethod<T extends (...args: never[]) => unknown>(method: T | undefined, name: string): T {
  if (!method) throw new Error(`Active backend does not support ${name}.`);
  return method;
}

type TabId = 'server' | 'mcp' | 'lsp' | 'plugins' | 'skills' | 'token' | 'codex';
const activeTab = ref<TabId>('server');

const serverHealth = ref<{ healthy: boolean; version: string } | null>(null);
const mcpData = ref<
  Record<
    string,
    | { status: 'connected' }
    | { status: 'disabled' }
    | { status: 'failed'; error: string }
    | { status: 'needs_auth' }
    | { status: 'needs_client_registration'; error: string }
  >
  | null
>(null);
const lspData = ref<Array<{ id: string; name: string; root: string; status: 'connected' | 'error' }> | null>(null);
const skillData = ref<Array<{ name: string; version?: string }> | null>(null);
const skillUnsupported = ref(false);
const configData = ref<Record<string, unknown> | null>(null);
const tokenUsage = ref<MessageUsage | null>(null);
const tokenModelName = ref<string>('');
const tokenContextLimit = ref<number>(0);
const tokenUserMessages = ref<number>(0);
const tokenAssistantMessages = ref<number>(0);
const codexApiKeyInput = ref('');

const loading = ref(false);
const errorMessage = ref('');
const togglingMcp = ref<string | null>(null);

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
    activeTab.value = 'server';
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
    refresh();
  } else {
    unbindEvents();
  }
});

watch(() => props.sessionId, (newId, oldId) => {
  if (props.open && newId !== oldId) {
    fetchTokenData();
  }
});

onBeforeUnmount(() => {
  unbindEvents();
});

async function refresh() {
  loading.value = true;
  errorMessage.value = '';
  skillUnsupported.value = false;
  try {
    const [health, mcp, lsp, skills, cfg] = await Promise.allSettled([
      requireBackendMethod(backend().getGlobalHealth, 'global health')(),
      requireBackendMethod(backend().getMcpStatus, 'MCP status')(),
      requireBackendMethod(backend().getLspStatus, 'LSP status')(),
      requireBackendMethod(backend().getSkillStatus, 'skill status')().catch(async () => {
        // Current OpenCode version may not expose /skill endpoint
        skillUnsupported.value = true;
        return [] as Array<{ name: string; version?: string }>;
      }),
      requireBackendMethod(backend().getGlobalConfig, 'global config')() as Promise<Record<string, unknown>>,
    ]);
    serverHealth.value = health.status === 'fulfilled' ? health.value : null;
    mcpData.value = mcp.status === 'fulfilled'
      ? (mcp.value as typeof mcpData.value)
      : null;
    lspData.value = lsp.status === 'fulfilled'
      ? (lsp.value as typeof lspData.value)
      : null;
    skillData.value = skills.status === 'fulfilled'
      ? (skills.value as typeof skillData.value)
      : null;
    configData.value = cfg.status === 'fulfilled' ? cfg.value : null;

    // Fetch token data for current session separately
    if (props.sessionId) {
      await fetchTokenData();
    }
    await refreshCodexStatus();

    if (
      health.status === 'rejected' &&
      mcp.status === 'rejected' &&
      lsp.status === 'rejected' &&
      cfg.status === 'rejected'
    ) {
      errorMessage.value = t('statusMonitor.error');
    }
  } catch (e) {
    errorMessage.value = t('statusMonitor.error');
  } finally {
    loading.value = false;
  }
}

async function refreshCodexStatus() {
  if (codexApi.status.value !== 'connected') return;
  try {
    await Promise.allSettled([
      codexApi.refreshAccount(),
      codexApi.refreshAccountRateLimits(),
    ]);
  } catch {
    errorMessage.value = t('statusMonitor.error');
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

const codexRateLimitPercent = computed(() => {
  const limits = codexApi.accountRateLimits.value;
  if (!limits || typeof limits.primary?.usedPercent !== 'number') return 0;
  return Math.max(0, Math.min(100, Math.round(limits.primary.usedPercent)));
});

async function fetchContextLimit(providerId: string, modelId: string) {
  try {
    const listProviders = requireBackendMethod(backend().listProviders, 'providers');
    const response = await listProviders() as { all?: Array<{ id: string; models?: Record<string, { limit?: { context?: number } }> }> };
    const providers = Array.isArray(response?.all) ? response.all : [];
    const provider = providers.find((p) => p.id === providerId);
    if (provider?.models) {
      const model = provider.models[modelId];
      if (model?.limit?.context) {
        tokenContextLimit.value = model.limit.context;
      }
    }
  } catch {
    // Provider list may fail, ignore
  }
}

async function fetchTokenData() {
  if (!props.sessionId) return;

  // Try to get messages from useMessages store first
  let sessionMessages: MessageInfo[] = [];
  const sessionRoots = msg.roots.value.filter((root) => root.sessionID === props.sessionId);
  for (const root of sessionRoots) {
    sessionMessages.push(...msg.getThread(root.id));
  }

  // If store doesn't have this session's messages, load via API
  if (sessionMessages.length === 0) {
    try {
      const listSessionMessages = requireBackendMethod(backend().listSessionMessages, 'session messages');
      const messages = await listSessionMessages(props.sessionId, { limit: 100 });
      if (Array.isArray(messages) && messages.length > 0) {
        msg.loadHistory(messages);
        // Re-fetch from store after loading
        const newRoots = msg.roots.value.filter((root) => root.sessionID === props.sessionId);
        for (const root of newRoots) {
          sessionMessages.push(...msg.getThread(root.id));
        }
      }
    } catch {
      tokenUsage.value = null;
      return;
    }
  }

  if (sessionMessages.length === 0) {
    tokenUsage.value = null;
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

  tokenUsage.value = latestUsage;
  tokenModelName.value = latestModelName;
  tokenUserMessages.value = userCount;
  tokenAssistantMessages.value = assistantCount;

  // Fetch model context limit
  if (latestUsage?.providerId && latestUsage?.modelId) {
    await fetchContextLimit(latestUsage.providerId, latestUsage.modelId);
  }
}

const mcpEntries = computed(() => {
  if (!mcpData.value) return [];
  return Object.entries(mcpData.value).map(([name, item]) => ({ name, ...item }));
});

const pluginEntries = computed(() => {
  const plugins = configData.value?.plugin;
  if (Array.isArray(plugins)) return plugins.map((p) => String(p));
  if (typeof plugins === 'object' && plugins !== null) return Object.keys(plugins);
  return [];
});

const skillEntries = computed(() => {
  if (skillData.value) return skillData.value.map((s) => s.name);
  const skills = configData.value?.skills;
  if (Array.isArray(skills)) return skills.map((s) => (typeof s === 'string' ? s : s?.name || String(s)));
  if (typeof skills === 'object' && skills !== null) return Object.keys(skills);
  return [];
});

async function handleMcpToggle(name: string, currentStatus: string) {
  const nextEnabled = currentStatus === 'disabled';
  const mcpConfigs = configData.value?.mcp;
  const baseConfig = typeof mcpConfigs === 'object' && mcpConfigs !== null
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

const tabs: { id: TabId; labelKey: string }[] = [
  { id: 'server', labelKey: 'statusMonitor.tabs.server' },
  { id: 'mcp', labelKey: 'statusMonitor.tabs.mcp' },
  { id: 'lsp', labelKey: 'statusMonitor.tabs.lsp' },
  { id: 'plugins', labelKey: 'statusMonitor.tabs.plugins' },
  { id: 'skills', labelKey: 'statusMonitor.tabs.skills' },
  { id: 'token', labelKey: 'statusMonitor.tabs.token' },
  { id: 'codex', labelKey: 'statusMonitor.tabs.codex' },
];

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
      return pluginEntries.value.length > 0
        ? { label: t('statusMonitor.common.totalLabel'), count: pluginEntries.value.length }
        : null;
    case 'skills':
      return skillEntries.value.length > 0
        ? { label: t('statusMonitor.common.totalLabel'), count: skillEntries.value.length }
        : null;
    case 'token':
      return tokenUsage.value
        ? { label: t('statusMonitor.token.totalTokens'), count: tokenUsage.value.tokens.total ?? (tokenUsage.value.tokens.input + tokenUsage.value.tokens.output + tokenUsage.value.tokens.reasoning) }
        : null;
    case 'codex':
      return codexApi.accountRateLimits.value
        ? { label: t('statusMonitor.codex.rateLimitUsed'), count: codexRateLimitPercent.value }
        : null;
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

    <div class="status-monitor-tabs" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        class="status-monitor-tab"
        :class="{ 'is-active': activeTab === tab.id }"
        :aria-selected="activeTab === tab.id"
        @click="activeTab = tab.id"
      >
        {{ $t(tab.labelKey) }}
      </button>
    </div>

    <div class="status-monitor-body">
      <div v-if="currentTotalInfo" class="status-monitor-actions">
          <span class="status-monitor-summary-label">{{ currentTotalInfo.label }}</span>
          <span class="status-monitor-summary-value">{{ currentTotalInfo.count }}</span>
        </div>

        <div v-if="errorMessage" class="status-monitor-feedback is-error">
          <span>{{ errorMessage }}</span>
          <button type="button" class="retry-button" @click="refresh">
            {{ $t('statusMonitor.retry') }}
          </button>
        </div>

        <!-- Server Tab -->
        <div v-if="activeTab === 'server'" class="status-monitor-content">
          <div v-if="loading && !serverHealth" class="status-monitor-empty">
            {{ $t('statusMonitor.loading') }}
          </div>
          <div v-else-if="!serverHealth" class="status-monitor-empty">
            {{ $t('statusMonitor.server.noData') }}
          </div>
          <div v-else class="status-monitor-list">
            <div class="status-monitor-row">
              <div class="status-monitor-row-main">
                <span class="status-dot" :class="serverHealth.healthy ? 'status-dot-success' : 'status-dot-error'" />
                <span class="status-monitor-name">{{ $t('statusMonitor.server.status') }}</span>
              </div>
              <span class="status-monitor-meta">
                {{ serverHealth.healthy ? $t('statusMonitor.server.healthy') : $t('statusMonitor.server.unhealthy') }}
              </span>
            </div>
            <div class="status-monitor-row">
              <div class="status-monitor-row-main">
                <span class="status-monitor-name">{{ $t('statusMonitor.server.version') }}</span>
              </div>
              <span class="status-monitor-meta">{{ serverHealth.version }}</span>
            </div>
          </div>
        </div>

        <!-- MCP Tab -->
        <div v-if="activeTab === 'mcp'" class="status-monitor-content">
          <div v-if="loading && !mcpData" class="status-monitor-empty">
            {{ $t('statusMonitor.loading') }}
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
                  <span class="status-monitor-meta">{{ mcpStatusText(item.status) }}</span>
                  <span v-if="'error' in item && item.error" class="status-monitor-error">
                    {{ item.error }}
                  </span>
                </div>
                <label
                  class="toggle-switch"
                  :title="item.status === 'disabled' ? $t('statusMonitor.mcp.enable') : $t('statusMonitor.mcp.disable')"
                >
                  <input
                    type="checkbox"
                    class="toggle-input"
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
          <div v-if="loading && !configData" class="status-monitor-empty">
            {{ $t('statusMonitor.loading') }}
          </div>
          <div v-else-if="pluginEntries.length === 0" class="status-monitor-empty">
            {{ $t('statusMonitor.plugins.noData') }}
          </div>
          <div v-else class="status-monitor-list">
            <div
              v-for="name in pluginEntries"
              :key="name"
              class="status-monitor-row"
            >
              <div class="status-monitor-row-main">
                <span class="status-dot status-dot-success" />
                <span class="status-monitor-name">{{ name }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Skills Tab -->
        <div v-if="activeTab === 'skills'" class="status-monitor-content">
          <div v-if="loading && skillEntries.length === 0" class="status-monitor-empty">
            {{ $t('statusMonitor.loading') }}
          </div>
          <div v-else-if="skillUnsupported && skillEntries.length === 0" class="status-monitor-empty">
            {{ $t('statusMonitor.skills.unsupported') }}
          </div>
          <div v-else-if="skillEntries.length === 0" class="status-monitor-empty">
            {{ $t('statusMonitor.skills.noData') }}
          </div>
          <div v-else class="status-monitor-list">
            <div
              v-for="name in skillEntries"
              :key="name"
              class="status-monitor-row"
            >
              <div class="status-monitor-row-main">
                <span class="status-dot status-dot-success" />
                <span class="status-monitor-name">{{ name }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Token Tab -->
        <div v-if="activeTab === 'token'" class="status-monitor-content">
          <div v-if="!sessionId" class="status-monitor-empty">
            {{ $t('statusMonitor.token.noSession') }}
          </div>
          <div v-else-if="loading && !tokenUsage" class="status-monitor-empty">
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
                  :style="{ width: formatPercent(tokenUsage.tokens.total ?? (tokenUsage.tokens.input + tokenUsage.tokens.output + tokenUsage.tokens.reasoning), tokenContextLimit) }"
                />
              </div>
              <span class="token-usage-percent">
                {{ formatPercent(tokenUsage.tokens.total ?? (tokenUsage.tokens.input + tokenUsage.tokens.output + tokenUsage.tokens.reasoning), tokenContextLimit) }}
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
            <div class="status-monitor-row token-row">
              <span class="token-label">{{ $t('statusMonitor.token.inputTokens') }}</span>
              <span class="token-value">{{ formatTokenCount(tokenUsage.tokens.input) }}</span>
            </div>
            <div class="status-monitor-row token-row">
              <span class="token-label">{{ $t('statusMonitor.token.outputTokens') }}</span>
              <span class="token-value">{{ formatTokenCount(tokenUsage.tokens.output) }}</span>
            </div>
            <div class="status-monitor-row token-row">
              <span class="token-label">{{ $t('statusMonitor.token.reasoningTokens') }}</span>
              <span class="token-value">{{ formatTokenCount(tokenUsage.tokens.reasoning) }}</span>
            </div>
            <div v-if="tokenUsage.tokens.cache" class="status-monitor-row token-row">
              <span class="token-label">{{ $t('statusMonitor.token.cacheTokens') }}</span>
              <span class="token-value">{{ formatTokenCount(tokenUsage.tokens.cache.read) }} / {{ formatTokenCount(tokenUsage.tokens.cache.write) }}</span>
            </div>
            <div class="status-monitor-row token-row">
              <span class="token-label">{{ $t('statusMonitor.token.userMessages') }}</span>
              <span class="token-value">{{ tokenUserMessages }}</span>
            </div>
            <div class="status-monitor-row token-row">
              <span class="token-label">{{ $t('statusMonitor.token.assistantMessages') }}</span>
              <span class="token-value">{{ tokenAssistantMessages }}</span>
            </div>
          </div>
        </div>

        <!-- Codex Tab -->
        <div v-if="activeTab === 'codex'" class="status-monitor-content">
          <div v-if="codexApi.status.value !== 'connected'" class="status-monitor-empty">
            {{ $t('statusMonitor.codex.notConnected') }}
          </div>
          <div v-else class="status-monitor-list">
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
                  <span v-if="codexApi.accountPlanType.value" class="status-monitor-meta">
                    {{ codexApi.accountPlanType.value }}
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

            <div class="status-monitor-row token-row">
              <span class="token-label">{{ $t('statusMonitor.codex.rateLimits') }}</span>
              <span class="token-value">
                {{ codexApi.accountRateLimits.value ? `${codexRateLimitPercent}%` : '-' }}
              </span>
            </div>
            <div v-if="codexApi.accountRateLimits.value" class="token-usage-bar-row">
              <div class="token-usage-track">
                <div class="token-usage-fill" :style="{ width: `${codexRateLimitPercent}%` }" />
              </div>
              <span class="token-usage-percent">{{ codexRateLimitPercent }}%</span>
            </div>
            <button
              type="button"
              class="status-monitor-action-button"
              @click="refreshCodexStatus"
            >
              {{ $t('statusMonitor.codex.refresh') }}
            </button>
          </div>
        </div>

    </div>

    <div class="status-monitor-footer">
      <button
        type="button"
        class="refresh-button"
        :disabled="loading"
        :title="loading ? $t('statusMonitor.refreshing') : $t('statusMonitor.refresh')"
        @click="refresh"
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
  color: var(--theme-text-primary, #e2e8f0);
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
  padding-right: 4px;
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
  word-break: break-all;
  overflow-wrap: anywhere;
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

.status-monitor-meta.is-error {
  color: var(--theme-text-danger, #fca5a5);
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

.token-usage-bar-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--theme-modal-border, rgba(148, 163, 184, 0.12));
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
</style>
