<template>
  <dialog
    ref="dialogRef"
    class="provider-manager-backdrop"
    @close="$emit('close')"
    @cancel.prevent
    @click.self="dialogRef?.close()"
  >
    <div class="provider-manager-modal">
      <header class="provider-manager-header">
        <div class="provider-manager-title-wrap">
          <div class="provider-manager-title">{{ $t('providerManager.title') }}</div>
        </div>
        <button
          type="button"
          class="provider-manager-close"
          :aria-label="$t('providerManager.close')"
          @click="dialogRef?.close()"
        >
          <Icon icon="lucide:x" :width="14" :height="14" />
        </button>
      </header>

      <div class="provider-manager-body">
        <div class="provider-manager-tabs" role="tablist">
          <button
            type="button"
            class="provider-manager-tab"
            :class="{ 'is-active': activeTab === 'providers' }"
            :aria-selected="activeTab === 'providers'"
            @click="activeTab = 'providers'"
          >
            {{ $t('providerManager.tabs.providers') }}
          </button>
          <button
            type="button"
            class="provider-manager-tab"
            :class="{ 'is-active': activeTab === 'models' }"
            :aria-selected="activeTab === 'models'"
            @click="activeTab = 'models'"
          >
            {{ $t('providerManager.tabs.models') }}
          </button>
        </div>

        <div v-if="feedbackMessage" class="provider-manager-feedback" :class="`is-${feedbackTone}`">
          {{ feedbackMessage }}
        </div>

        <template v-if="activeTab === 'providers'">
          <div class="provider-sections">
            <section class="provider-section">
              <div class="provider-section-header">
                <div class="section-heading-row">
                  <div class="section-heading provider-section-title">
                    {{ $t('providerManager.sections.connected') }}
                  </div>
                  <span class="status-badge is-muted">{{ connectedProviders.length }}</span>
                </div>
                <div class="section-meta">{{ $t('providerManager.sections.connectedDescription') }}</div>
              </div>

              <div class="provider-list-shell">
                <div v-if="connectedProviders.length === 0" class="provider-empty-state">
                  {{ $t('providerManager.sections.connectedEmpty') }}
                </div>
                <article
                  v-for="provider in connectedProviders"
                  :key="`connected-${provider.id}`"
                  class="provider-list-row"
                >
                  <div class="provider-list-row-main">
                    <div class="provider-list-row-head">
                      <div class="provider-list-row-title">
                        <span class="provider-name">{{ provider.name?.trim() || provider.id }}</span>
                        <span class="provider-id">{{ provider.id }}</span>
                      </div>
                      <div class="provider-badges">
                        <span
                          class="status-badge"
                          :class="isProviderEnabled(provider.id) ? 'is-enabled' : 'is-disabled'"
                        >
                          {{
                            isProviderEnabled(provider.id)
                              ? $t('providerManager.badges.enabled')
                              : $t('providerManager.badges.disabled')
                          }}
                        </span>
                        <span class="status-badge is-muted">{{ providerTypeLabel(provider) }}</span>
                      </div>
                    </div>
                    <div class="provider-stats compact">
                      <span>{{ $t('providerManager.providerStats.models', { count: providerModelCount(provider) }) }}</span>
                      <span>
                        {{
                          $t('providerManager.providerStats.enabledModels', {
                            count: providerEnabledModelCount(provider),
                          })
                        }}
                      </span>
                    </div>
                    <div v-if="providerNote(provider.id)" class="provider-note">
                      {{ providerNote(provider.id) }}
                    </div>
                  </div>
                  <div class="provider-list-row-actions">
                    <label class="provider-toggle compact">
                      <span>{{ $t('providerManager.actions.available') }}</span>
                      <input
                        :checked="isProviderEnabled(provider.id)"
                        type="checkbox"
                        class="toggle-input"
                        :disabled="busyProviderId === provider.id"
                        @change="toggleProvider(provider.id, ($event.target as HTMLInputElement).checked)"
                      />
                      <span class="toggle-track" />
                    </label>
                    <button
                      type="button"
                      class="ghost-action danger"
                      :disabled="!canDisconnectProvider(provider) || busyProviderId === provider.id"
                      @click="disconnectProvider(provider.id)"
                    >
                      {{ $t('providerManager.actions.disconnect') }}
                    </button>
                  </div>
                </article>
              </div>
            </section>

            <section class="provider-section">
              <button
                type="button"
                class="provider-view-all-toggle"
                :aria-expanded="viewAllExpanded"
                @click="viewAllExpanded = !viewAllExpanded"
              >
                <div class="provider-view-all-toggle-text">
                  <span class="provider-view-all-toggle-title">{{ $t('providerManager.sections.allProviders') }}</span>
                  <span class="provider-view-all-toggle-meta">{{ $t('providerManager.sections.allProvidersDescription') }}</span>
                </div>
                <Icon
                  :icon="viewAllExpanded ? 'lucide:chevron-up' : 'lucide:chevron-down'"
                  :width="14"
                  :height="14"
                />
              </button>

              <div v-show="viewAllExpanded" class="provider-view-all-panel">
                <div class="provider-view-all-grid">
                <button
                  v-for="provider in allProvidersForView"
                  :key="`all-${provider.id}`"
                  type="button"
                  class="provider-mini-card"
                  :class="{ 'is-disabled': !isProviderEnabled(provider.id) }"
                  :disabled="busyProviderId === provider.id"
                  @click="isProviderDisconnected(provider) ? connectProvider(provider) : selectProvider(provider.id)"
                >
                  <span class="provider-mini-card-name">{{ provider.name?.trim() || provider.id }}</span>
                  <span class="provider-mini-card-meta">{{ provider.id }}</span>
                  <span class="status-badge" :class="isProviderDisconnected(provider) ? 'is-warning' : 'is-enabled'">
                    {{
                      isProviderDisconnected(provider)
                        ? $t('providerManager.badges.disconnected')
                        : $t('providerManager.badges.enabled')
                    }}
                  </span>
                </button>
              </div>
            </div>
            </section>
          </div>
        </template>

        <template v-else>
          <section class="model-toolbar">
            <label class="model-search-field">
              <Icon icon="lucide:search" :width="14" :height="14" />
              <input
                v-model.trim="modelSearch"
                type="search"
                :placeholder="$t('providerManager.models.searchPlaceholder')"
              />
            </label>
            <div class="model-toolbar-stats">
              <span>{{ $t('providerManager.models.total', { count: filteredModels.length }) }}</span>
              <span>{{ $t('providerManager.models.disabledCount', { count: disabledModelCount }) }}</span>
            </div>
          </section>

          <div v-if="filteredGroups.length === 0" class="models-empty">
            {{ $t('providerManager.models.empty') }}
          </div>

          <div v-else class="model-group-list">
            <section
              v-for="group in filteredGroups"
              :key="group.provider.id"
              class="model-group"
            >
              <div class="model-group-header">
                <div>
                  <div class="provider-name">{{ group.provider.name?.trim() || group.provider.id }}</div>
                  <div class="provider-id">{{ group.provider.id }}</div>
                </div>
                <span
                  class="status-badge"
                  :class="isProviderEnabled(group.provider.id) ? 'is-enabled' : 'is-disabled'"
                >
                  {{
                    isProviderEnabled(group.provider.id)
                      ? $t('providerManager.badges.enabled')
                      : $t('providerManager.badges.disabled')
                  }}
                </span>
              </div>

              <div class="model-list">
                <article
                  v-for="model in group.models"
                  :key="model.key"
                  class="model-row"
                  :class="{
                    'is-selected': model.key === selectedModel,
                    'is-disabled': isModelDisabled(model.key) || !isProviderEnabled(group.provider.id),
                  }"
                >
                  <div class="model-row-main">
                    <div class="model-row-head">
                      <div>
                        <div class="model-name">{{ model.name }}</div>
                        <div class="model-id">{{ model.key }}</div>
                      </div>
                      <div class="provider-badges">
                        <span v-if="model.capabilities?.reasoning" class="capability-chip">
                          {{ $t('providerManager.models.capabilities.reasoning') }}
                        </span>
                        <span v-if="model.capabilities?.toolcall" class="capability-chip">
                          {{ $t('providerManager.models.capabilities.toolcall') }}
                        </span>
                        <span v-if="model.capabilities?.attachment" class="capability-chip">
                          {{ $t('providerManager.models.capabilities.attachment') }}
                        </span>
                      </div>
                    </div>

                    <div class="model-meta-row">
                      <span v-if="model.family">{{ model.family }}</span>
                      <span v-if="model.limit?.context">
                        {{ $t('providerManager.models.context', { count: formatCount(model.limit.context) }) }}
                      </span>
                      <span v-if="model.limit?.output">
                        {{ $t('providerManager.models.output', { count: formatCount(model.limit.output) }) }}
                      </span>
                    </div>
                  </div>

                  <div class="model-row-actions">
                    <label class="provider-toggle compact">
                      <span>
                        {{
                          isModelDisabled(model.key)
                            ? $t('providerManager.actions.disabled')
                            : $t('providerManager.actions.enabled')
                        }}
                      </span>
                      <input
                        :checked="!isModelDisabled(model.key)"
                        type="checkbox"
                        class="toggle-input"
                        @change="toggleModel(model.key, ($event.target as HTMLInputElement).checked)"
                      />
                      <span class="toggle-track" />
                    </label>
                  </div>
                </article>
              </div>
            </section>
          </div>
        </template>
      </div>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import * as opencodeApi from '../utils/opencode';

type ProviderManagerTab = 'providers' | 'models';

type ProviderCapabilitySet = {
  attachment?: boolean;
  reasoning?: boolean;
  toolcall?: boolean;
};

type ProviderModel = {
  id: string;
  name?: string;
  providerID?: string;
  family?: string;
  status?: string;
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
  capabilities?: ProviderCapabilitySet;
};

type ProviderInfo = {
  id: string;
  name?: string;
  source?: string;
  key?: string;
  models?: Record<string, ProviderModel>;
};

type ProviderConfigState = {
  enabled_providers?: string[];
  disabled_providers?: string[];
};

type ProviderAuthMethod = {
  type: 'oauth' | 'api';
  label: string;
};

type ProviderAuthAuthorization = {
  url: string;
  method: 'auto' | 'code';
  instructions: string;
};

const POPULAR_PROVIDER_IDS = ['opencode', 'opencode-go', 'openai', 'github-copilot', 'anthropic', 'google'];

const PROVIDER_NOTES: Record<string, string> = {
  opencode: 'Single key access to multiple coding models.',
  'opencode-go': 'Low-cost subscription access for everyday coding work.',
  anthropic: 'Connect Claude directly with your Anthropic credentials.',
  'github-copilot': 'Use your GitHub Copilot access or API-backed auth flow.',
  openai: 'Bring ChatGPT or API credentials into the provider pool.',
  google: 'Connect Gemini models with Google credentials.',
  openrouter: 'Access multiple hosted models through one router.',
  vercel: 'Use Vercel AI Gateway-compatible credentials.',
};

type ModelVisibilityEntry = {
  providerID: string;
  modelID: string;
  visibility: 'show' | 'hide';
};

const props = defineProps<{
  open: boolean;
  providers: ProviderInfo[];
  connectedProviderIds: string[];
  selectedModel: string;
  hiddenModels: string[];
  providerConfig: ProviderConfigState | null;
}>();

const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'select-model', value: string): void;
  (event: 'update:model-visibility', value: ModelVisibilityEntry[]): void;
  (event: 'config-updated', value: ProviderConfigState): void;
  (event: 'providers-changed'): void;
}>();

const dialogRef = ref<HTMLDialogElement | null>(null);
const activeTab = ref<ProviderManagerTab>('providers');
const modelSearch = ref('');
const busyProviderId = ref('');
const feedbackMessage = ref('');
const feedbackTone = ref<'info' | 'success' | 'error'>('info');
const authMethods = ref<Record<string, ProviderAuthMethod[]>>({});
const viewAllExpanded = ref(false);

const hiddenModelSet = computed(() => new Set(props.hiddenModels));
const connectedProviderIdSet = computed(() => new Set(props.connectedProviderIds));

const sortedProviders = computed(() =>
  [...props.providers].sort((a, b) => {
    const disconnectedDelta = Number(isProviderDisconnected(b)) - Number(isProviderDisconnected(a));
    if (disconnectedDelta !== 0) return disconnectedDelta;
    return (a.name?.trim() || a.id).localeCompare(b.name?.trim() || b.id);
  }),
);

const connectedProviders = computed(() =>
  sortedProviders.value.filter((provider) => !isProviderDisconnected(provider)),
);

const allProvidersForView = computed(() =>
  [...props.providers].sort((a, b) => {
    const connectedDelta = Number(connectedProviderIdSet.value.has(b.id)) - Number(connectedProviderIdSet.value.has(a.id));
    if (connectedDelta !== 0) return connectedDelta;
    const popularDelta = Number(POPULAR_PROVIDER_IDS.includes(a.id)) - Number(POPULAR_PROVIDER_IDS.includes(b.id));
    if (popularDelta !== 0) return popularDelta;
    return (a.name?.trim() || a.id).localeCompare(b.name?.trim() || b.id);
  }),
);

const allModels = computed(() =>
  props.providers
    .filter((provider) => connectedProviderIdSet.value.has(provider.id))
    .flatMap((provider) =>
      Object.values(provider.models ?? {}).map((model) => ({
        key: `${provider.id}/${model.id}`,
        provider,
        providerID: provider.id,
        name: model.name?.trim() || model.id,
        modelID: model.id,
        family: model.family,
        status: model.status,
        limit: model.limit,
        capabilities: model.capabilities,
      })),
    ),
);

const filteredModels = computed(() => {
  const query = modelSearch.value.trim().toLowerCase();
  if (!query) return allModels.value;
  return allModels.value.filter((model) =>
    [model.name, model.modelID, model.providerID, model.family]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query)),
  );
});

const filteredGroups = computed(() => {
  const grouped = new Map<string, { provider: ProviderInfo; models: typeof filteredModels.value }>();
  filteredModels.value.forEach((model) => {
    const existing = grouped.get(model.providerID);
    if (existing) {
      existing.models.push(model);
      return;
    }
    grouped.set(model.providerID, {
      provider: model.provider,
      models: [model],
    });
  });
  return Array.from(grouped.values()).sort((a, b) =>
    (a.provider.name?.trim() || a.provider.id).localeCompare(b.provider.name?.trim() || b.provider.id),
  );
});

const disabledModelCount = computed(() => props.hiddenModels.length);

watch(
  () => props.open,
  (open) => {
    const el = dialogRef.value;
    if (!el) return;
    if (open) {
      activeTab.value = 'providers';
      modelSearch.value = '';
      feedbackMessage.value = '';
      void fetchAuthMethods();
      if (!el.open) el.showModal();
    } else if (el.open) {
      el.close();
    }
  },
);

function setFeedback(message: string, tone: 'info' | 'success' | 'error' = 'info') {
  feedbackMessage.value = message;
  feedbackTone.value = tone;
}

async function fetchAuthMethods() {
  try {
    const data = (await opencodeApi.listProviderAuthMethods()) as Record<string, ProviderAuthMethod[]>;
    authMethods.value = data && typeof data === 'object' ? data : {};
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : String(error), 'error');
  }
}

function normalizeIds(values?: string[]) {
  return Array.isArray(values)
    ? values.map((value) => value.trim()).filter((value) => value.length > 0)
    : [];
}

function isProviderEnabled(providerId: string) {
  const enabled = normalizeIds(props.providerConfig?.enabled_providers);
  const disabled = new Set(normalizeIds(props.providerConfig?.disabled_providers));
  if (enabled.length > 0) {
    return enabled.includes(providerId) && !disabled.has(providerId);
  }
  return !disabled.has(providerId);
}

function isModelDisabled(modelKey: string) {
  return hiddenModelSet.value.has(modelKey);
}

function providerModelCount(provider: ProviderInfo) {
  return Object.keys(provider.models ?? {}).length;
}

function providerEnabledModelCount(provider: ProviderInfo) {
  return Object.values(provider.models ?? {}).filter(
    (model) => !isModelDisabled(`${provider.id}/${model.id}`),
  ).length;
}

function providerPrimaryModelId(provider: ProviderInfo) {
  return Object.values(provider.models ?? {})
    .map((model) => `${provider.id}/${model.id}`)
    .find((modelKey) => !isModelDisabled(modelKey));
}

function providerAuthSummary(providerId: string) {
  return authMethods.value[providerId] ?? [];
}

function isProviderDisconnected(provider: ProviderInfo) {
  return !connectedProviderIdSet.value.has(provider.id);
}

function canDisconnectProvider(provider: ProviderInfo) {
  return !isProviderDisconnected(provider);
}

function providerTypeLabel(provider: ProviderInfo) {
  const source = provider.source?.trim();
  if (source === 'env') return 'Environment';
  if (source === 'api') return 'API key';
  if (source === 'custom') return 'Custom';
  if (source === 'config') return 'Config';
  return source || 'Provider';
}

function providerNote(providerId: string) {
  return PROVIDER_NOTES[providerId] ?? '';
}

function formatCount(value?: number) {
  if (!value || !Number.isFinite(value)) return '—';
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function pickAuthMethod(providerId: string) {
  const methods = providerAuthSummary(providerId);
  if (methods.length === 0) return null;
  if (methods.length === 1) return { method: methods[0], index: 0 };
  const options = methods.map((method, index) => `${index + 1}. ${method.label}`).join('\n');
  const raw = window.prompt(`Select auth method for ${providerId}:\n${options}`, '1');
  if (!raw) return null;
  const index = Number(raw) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= methods.length) return null;
  return { method: methods[index], index };
}

async function toggleProvider(providerId: string, nextEnabled: boolean) {
  busyProviderId.value = providerId;
  try {
    const currentEnabled = normalizeIds(props.providerConfig?.enabled_providers);
    const currentDisabled = new Set(normalizeIds(props.providerConfig?.disabled_providers));
    if (nextEnabled) {
      currentDisabled.delete(providerId);
      if (currentEnabled.length > 0 && !currentEnabled.includes(providerId)) {
        currentEnabled.push(providerId);
      }
    } else {
      if (currentEnabled.length > 0) {
        const next = currentEnabled.filter((entry) => entry !== providerId);
        currentEnabled.splice(0, currentEnabled.length, ...next);
      } else {
        currentDisabled.add(providerId);
      }
    }
    const result = (await opencodeApi.updateGlobalConfig({
      enabled_providers: currentEnabled.length > 0 ? currentEnabled : [],
      disabled_providers: Array.from(currentDisabled),
    })) as ProviderConfigState;
    emit('config-updated', result ?? {});
    setFeedback(
      nextEnabled
        ? `Provider ${providerId} is now available.`
        : `Provider ${providerId} has been disabled.`,
      'success',
    );
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    busyProviderId.value = '';
  }
}

function toggleModel(modelKey: string, nextEnabled: boolean) {
  const nextByKey = new Map<string, ModelVisibilityEntry>();
  props.hiddenModels.forEach((key) => {
    const [providerID, modelID] = key.split('/');
    if (!providerID || !modelID) return;
    nextByKey.set(key, { providerID, modelID, visibility: 'hide' });
  });
  if (nextEnabled) {
    nextByKey.delete(modelKey);
  } else {
    const [providerID, modelID] = modelKey.split('/');
    if (providerID && modelID) {
      nextByKey.set(modelKey, { providerID, modelID, visibility: 'hide' });
    }
  }
  emit('update:model-visibility', Array.from(nextByKey.values()).sort((a, b) => `${a.providerID}/${a.modelID}`.localeCompare(`${b.providerID}/${b.modelID}`)));
  setFeedback(
    nextEnabled ? `Model ${modelKey} enabled.` : `Model ${modelKey} disabled.`,
    'success',
  );
}

function selectProvider(providerId: string) {
  const provider = props.providers.find((entry) => entry.id === providerId);
  const modelId = provider ? providerPrimaryModelId(provider) : undefined;
  if (!modelId) {
    setFeedback(`Provider ${providerId} has no enabled models available.`, 'error');
    return;
  }
  emit('select-model', modelId);
  setFeedback(`Switched to ${modelId}.`, 'success');
}

async function connectProvider(provider: ProviderInfo) {
  const picked = pickAuthMethod(provider.id);
  if (!picked) return;
  busyProviderId.value = provider.id;
  try {
    if (picked.method.type === 'api') {
      const key = window.prompt(`Enter API key for ${provider.name?.trim() || provider.id}`)?.trim();
      if (!key) return;
      await opencodeApi.setProviderAuth(provider.id, { type: 'api', key });
      emit('providers-changed');
      setFeedback(`Connected ${provider.id}.`, 'success');
      return;
    }

    const authorization = (await opencodeApi.authorizeProviderOAuth(provider.id, {
      method: picked.index,
    })) as ProviderAuthAuthorization;
    if (authorization?.url) {
      window.open(authorization.url, '_blank', 'noopener,noreferrer');
    }
    if (authorization?.method === 'code') {
      const code = window.prompt(authorization.instructions || `Paste the authorization code for ${provider.id}`)?.trim();
      if (!code) return;
      await opencodeApi.completeProviderOAuth(provider.id, {
        method: picked.index,
        code,
      });
    } else {
      const confirmed = window.confirm(
        authorization?.instructions || `Complete the OAuth flow for ${provider.id}, then confirm.`,
      );
      if (!confirmed) return;
      await opencodeApi.completeProviderOAuth(provider.id, {
        method: picked.index,
      });
    }
    emit('providers-changed');
    setFeedback(`Connected ${provider.id}.`, 'success');
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    busyProviderId.value = '';
  }
}

async function disconnectProvider(providerId: string) {
  if (!providerId) return;
  const confirmed = window.confirm(`Disconnect provider ${providerId}?`);
  if (!confirmed) return;
  busyProviderId.value = providerId;
  try {
    await opencodeApi.deleteProviderAuth(providerId);
    emit('providers-changed');
    setFeedback(`Disconnected ${providerId}.`, 'success');
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    busyProviderId.value = '';
  }
}
</script>

<style scoped>
.provider-manager-backdrop {
  border: none;
  padding: 0;
  margin: 0;
  background: transparent;
  color: inherit;
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

.provider-manager-backdrop:not([open]) {
  display: none;
}

.provider-manager-backdrop::backdrop {
  background: var(--region-modal-active-bg, rgba(2, 6, 23, 0.68));
}

.provider-manager-modal {
  width: min(980px, 96vw);
  max-height: min(88vh, 920px);
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  background: var(--region-modal-bg, rgba(15, 23, 42, 0.98));
  border: 1px solid var(--region-modal-border, #334155);
  border-radius: 14px;
  box-shadow: 0 20px 44px rgba(2, 6, 23, 0.45);
  color: var(--region-modal-text, #e2e8f0);
  font-family: var(--app-monospace-font-family);
}

.provider-manager-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.provider-manager-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.provider-manager-title {
  font-size: 15px;
  font-weight: 700;
}

.provider-manager-subtitle {
  font-size: 11px;
  color: #94a3b8;
}

.provider-manager-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--region-modal-border, #334155);
  border-radius: 8px;
  background: var(--region-modal-control-bg, transparent);
  color: var(--region-modal-text, #94a3b8);
  cursor: pointer;
}

.provider-manager-close:hover {
  background: var(--region-modal-active-bg, #1e293b);
  color: var(--region-modal-text, #e2e8f0);
}

.provider-manager-body {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
}

.provider-manager-tabs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  padding: 4px;
  border: 1px solid rgba(71, 85, 105, 0.42);
  border-radius: 10px;
  background: rgba(2, 6, 23, 0.45);
}

.provider-manager-tab {
  border: 1px solid rgba(100, 116, 139, 0.35);
  border-radius: 8px;
  background: var(--region-modal-control-bg, rgba(15, 23, 42, 0.7));
  color: #94a3b8;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  padding: 8px 12px;
  cursor: pointer;
}

.provider-manager-tab.is-active {
  background: var(--region-modal-active-bg, rgba(30, 64, 175, 0.45));
  color: #e2e8f0;
  border-color: var(--region-modal-accent, rgba(96, 165, 250, 0.6));
}

.provider-manager-feedback {
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 12px;
  border: 1px solid var(--region-modal-border, #334155);
}

.provider-manager-feedback.is-info {
  background: var(--region-modal-control-bg, rgba(30, 41, 59, 0.85));
  color: #cbd5e1;
}

.provider-manager-feedback.is-success {
  background: var(--region-modal-control-bg, rgba(20, 83, 45, 0.24));
  border-color: var(--region-modal-border, rgba(34, 197, 94, 0.35));
  color: #bbf7d0;
}

.provider-manager-feedback.is-error {
  background: var(--region-modal-control-bg, rgba(127, 29, 29, 0.22));
  border-color: var(--region-modal-border, rgba(248, 113, 113, 0.35));
  color: #fecaca;
}

.provider-card,
.model-toolbar,
.model-group,
.model-row {
  border: 1px solid rgba(51, 65, 85, 0.8);
  border-radius: 12px;
  background: rgba(2, 6, 23, 0.46);
}

.section-eyebrow {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #64748b;
}

.section-heading {
  margin-top: 4px;
  font-size: 14px;
  font-weight: 700;
  color: #f8fafc;
}

.section-meta {
  margin-top: 4px;
  font-size: 11px;
  color: #94a3b8;
}

.provider-sections,
.provider-card-list,
.model-group-list {
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-right: 4px;
}

.provider-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.provider-section-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.section-heading-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.provider-section-title {
  margin-top: 0;
}

.provider-list-shell {
  border: 1px solid rgba(51, 65, 85, 0.8);
  border-radius: 12px;
  background: rgba(2, 6, 23, 0.46);
  overflow: hidden;
}

.provider-empty-state {
  padding: 18px 14px;
  font-size: 12px;
  color: #94a3b8;
}

.provider-list-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 72px;
  padding: 14px;
  border-bottom: 1px solid rgba(51, 65, 85, 0.8);
}

.provider-list-row:last-child {
  border-bottom: none;
}

.provider-list-row-main {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.provider-list-row-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.provider-list-row-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.provider-list-row-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}

.provider-note {
  font-size: 12px;
  color: #94a3b8;
}

.provider-auth-methods.compact {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.auth-chip-list.left {
  justify-content: flex-start;
}

.provider-view-all-toggle {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid #334155;
  border-radius: 8px;
  background: var(--region-modal-control-bg, rgba(15, 23, 42, 0.72));
  color: #cbd5e1;
  font-size: 12px;
  font-family: inherit;
  padding: 10px 12px;
  cursor: pointer;
}

.provider-view-all-toggle:hover {
  border-color: #475569;
  background: rgba(30, 41, 59, 0.92);
}

.provider-view-all-toggle-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  text-align: left;
}

.provider-view-all-toggle-title {
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
}

.provider-view-all-toggle-meta {
  font-size: 11px;
  color: #94a3b8;
}

.provider-view-all-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.provider-view-all-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}

.provider-mini-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 12px;
  border: 1px solid rgba(51, 65, 85, 0.8);
  border-radius: 12px;
  background: var(--region-modal-control-bg, rgba(2, 6, 23, 0.46));
  color: #e2e8f0;
  text-align: left;
  cursor: pointer;
}

.provider-mini-card:hover {
  border-color: rgba(96, 165, 250, 0.45);
  background: rgba(15, 23, 42, 0.72);
}

.provider-mini-card.is-disabled {
  opacity: 0.72;
}

.provider-mini-card-name {
  font-size: 13px;
  font-weight: 700;
  color: #f8fafc;
}

.provider-mini-card-meta {
  font-size: 11px;
  color: #64748b;
}

.provider-card {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 14px;
}

.provider-card.is-current {
  border-color: rgba(96, 165, 250, 0.55);
  box-shadow: inset 0 0 0 1px rgba(59, 130, 246, 0.18);
}

.provider-card.is-disabled,
.model-row.is-disabled {
  opacity: 0.72;
}

.provider-card-main,
.model-row-main {
  min-width: 0;
  flex: 1 1 420px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.provider-card-head,
.model-row-head,
.model-group-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.provider-name,
.model-name {
  font-size: 13px;
  font-weight: 700;
  color: #f8fafc;
}

.provider-id,
.model-id {
  margin-top: 2px;
  font-size: 11px;
  color: #64748b;
}

.provider-badges,
.auth-chip-list,
.capability-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}

.status-badge,
.auth-chip,
.capability-chip {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid #334155;
  font-size: 11px;
}

.status-badge.is-enabled {
  border-color: rgba(34, 197, 94, 0.35);
  color: #bbf7d0;
}

.status-badge.is-disabled {
  border-color: rgba(248, 113, 113, 0.35);
  color: #fecaca;
}

.status-badge.is-current {
  border-color: #334155;
  color: #cbd5e1;
  background: rgba(15, 23, 42, 0.78);
}

.status-badge.is-warning {
  border-color: rgba(251, 191, 36, 0.35);
  color: #fde68a;
}

.status-badge.is-muted,
.auth-chip,
.capability-chip {
  color: #cbd5e1;
  background: rgba(15, 23, 42, 0.78);
}

.provider-stats,
.model-meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 11px;
  color: #94a3b8;
}

.provider-stats.compact {
  gap: 10px;
}

.provider-card-actions,
.model-row-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
}

.provider-action-group {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.ghost-action {
  border: 1px solid #334155;
  border-radius: 8px;
  background: var(--region-modal-control-bg, rgba(15, 23, 42, 0.82));
  color: #e2e8f0;
  font-size: 12px;
  font-family: inherit;
  padding: 7px 10px;
  cursor: pointer;
}

.ghost-action:hover {
  border-color: #475569;
  background: rgba(30, 41, 59, 0.92);
}

.ghost-action:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.ghost-action.danger {
  color: #fca5a5;
}

.ghost-action.secondary {
  border-color: rgba(96, 165, 250, 0.35);
  background: rgba(30, 64, 175, 0.16);
  color: #dbeafe;
}

.provider-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: #cbd5e1;
  font-size: 12px;
}

.provider-toggle.compact {
  justify-content: flex-end;
}

.toggle-input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.toggle-track {
  width: 36px;
  height: 20px;
  border-radius: 999px;
  background: var(--region-modal-border, rgba(51, 65, 85, 0.95));
  border: 1px solid var(--region-modal-border, rgba(100, 116, 139, 0.55));
  position: relative;
  transition: background 0.18s ease;
}

.toggle-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #e2e8f0;
  transition: transform 0.18s ease;
}

.toggle-input:checked + .toggle-track {
  background: var(--region-modal-accent, rgba(37, 99, 235, 0.9));
  border-color: var(--region-modal-accent, rgba(96, 165, 250, 0.65));
}

.toggle-input:checked + .toggle-track::after {
  transform: translateX(16px);
}

.model-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
}

.model-search-field {
  flex: 1 1 260px;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 0 12px;
  border: 1px solid #334155;
  border-radius: 10px;
  background: var(--region-modal-control-bg, rgba(15, 23, 42, 0.82));
  color: #94a3b8;
}

.model-search-field input {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: #e2e8f0;
  font-size: 12px;
  font-family: inherit;
}

.model-search-field input::placeholder {
  color: #64748b;
}

.model-toolbar-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 11px;
  color: #94a3b8;
}

.models-empty {
  padding: 30px 12px;
  text-align: center;
  font-size: 12px;
  color: #94a3b8;
}

.model-group {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.model-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-start;
  justify-content: space-between;
  padding: 12px;
}

.model-row.is-selected {
  border-color: rgba(96, 165, 250, 0.45);
}

@media (max-width: 760px) {
  .provider-manager-modal {
    width: min(100vw, 100vw);
    height: 100vh;
    max-height: 100vh;
    border-radius: 0;
    padding: 14px;
  }

  .provider-card,
  .provider-list-row,
  .model-row {
    flex-direction: column;
    align-items: stretch;
  }

  .provider-card-actions,
  .provider-list-row-actions,
  .model-row-actions {
    align-items: stretch;
  }

  .provider-action-group {
    justify-content: stretch;
  }

  .provider-action-group > * {
    flex: 1 1 auto;
  }

  .provider-view-all-grid {
    grid-template-columns: 1fr;
  }
}
</style>
