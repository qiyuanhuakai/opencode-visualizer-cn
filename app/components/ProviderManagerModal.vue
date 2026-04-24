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
                  <span class="section-heading-count">{{ connectedProviders.length }}</span>
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
                <div class="provider-view-all-list">
                  <article
                    v-for="provider in allProvidersForView"
                    :key="`all-${provider.id}`"
                    class="provider-mini-row"
                    :class="{ 'is-disabled': !isProviderEnabled(provider.id) }"
                  >
                    <div class="provider-mini-row-title">
                      <span class="provider-mini-row-name">{{ provider.name?.trim() || provider.id }}</span>
                      <span class="provider-mini-row-meta">{{ provider.id }}</span>
                    </div>
                    <div class="provider-mini-row-status">
                      <span class="status-badge" :class="isProviderDisconnected(provider) ? 'is-warning' : 'is-enabled'">
                        {{
                          isProviderDisconnected(provider)
                            ? $t('providerManager.badges.disconnected')
                            : $t('providerManager.badges.enabled')
                        }}
                      </span>
                      <button
                        v-if="isProviderDisconnected(provider)"
                        type="button"
                        class="ghost-action provider-mini-row-action"
                        :disabled="busyProviderId === provider.id"
                        @click="connectProvider(provider)"
                      >
                        {{ $t('providerManager.actions.connect') }}
                      </button>
                    </div>
                  </article>
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
import { computed, inject, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import * as opencodeApi from '../utils/opencode';
import {
  buildProviderDisabledPatch,
  normalizeProviderIds,
  type ProviderConfigState,
} from '../utils/providerConfig';

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
  (event: 'update:model-visibility', value: ModelVisibilityEntry[]): void;
  (event: 'config-updated', value: ProviderConfigState): void;
  (event: 'providers-changed'): void;
}>();

const dialogRef = ref<HTMLDialogElement | null>(null);
const activeTab = ref<ProviderManagerTab>('providers');
const modelSearch = ref('');
const showConfirm = inject('showConfirm') as ((message: string) => Promise<boolean>) | undefined;
const showPrompt = inject('showPrompt') as ((title: string, defaultValue?: string) => Promise<string | null>) | undefined;

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

function isProviderEnabled(providerId: string) {
  const enabled = normalizeProviderIds(props.providerConfig?.enabled_providers);
  const disabled = new Set(normalizeProviderIds(props.providerConfig?.disabled_providers));
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

async function pickAuthMethod(providerId: string) {
  const methods = providerAuthSummary(providerId);
  if (methods.length === 0) return null;
  if (methods.length === 1) return { method: methods[0], index: 0 };
  const options = methods.map((method, index) => `${index + 1}. ${method.label}`).join('\n');
  const raw = showPrompt ? await showPrompt(`Select auth method for ${providerId}:\n${options}`, '1') : null;
  if (!raw) return null;
  const index = Number(raw) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= methods.length) return null;
  return { method: methods[index], index };
}

async function toggleProvider(providerId: string, nextEnabled: boolean) {
  busyProviderId.value = providerId;
  try {
    const result = (await opencodeApi.updateGlobalConfig(
      buildProviderDisabledPatch(props.providerConfig, providerId, nextEnabled),
    )) as ProviderConfigState;
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

async function connectProvider(provider: ProviderInfo) {
  const picked = await pickAuthMethod(provider.id);
  if (!picked) return;
  busyProviderId.value = provider.id;
  try {
    if (picked.method.type === 'api') {
      const key = showPrompt ? await showPrompt(`Enter API key for ${provider.name?.trim() || provider.id}`) : null;
      if (!key) return;
      const trimmedKey = key.trim();
      await opencodeApi.setProviderAuth(provider.id, { type: 'api', key: trimmedKey });
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
      const code = showPrompt ? await showPrompt(authorization.instructions || `Paste the authorization code for ${provider.id}`) : null;
      if (!code) return;
      await opencodeApi.completeProviderOAuth(provider.id, {
        method: picked.index,
        code: code.trim(),
      });
    } else {
      const confirmed = showConfirm ? await showConfirm(
        authorization?.instructions || `Complete the OAuth flow for ${provider.id}, then confirm.`,
      ) : true;
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
  const confirmed = showConfirm ? await showConfirm(`Disconnect provider ${providerId}?`) : true;
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
  background: var(--theme-surface-overlay, rgba(2, 6, 23, 0.68));
}

.provider-manager-modal {
  width: min(980px, 96vw);
  max-height: min(88vh, 920px);
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  background: var(--theme-modal-bg, var(--theme-surface-panel-elevated, rgba(15, 23, 42, 0.98)));
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 14px;
  box-shadow: var(--theme-shadow-floating, 0 20px 44px rgba(2, 6, 23, 0.45));
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
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
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.provider-manager-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 8px;
  background: var(--theme-modal-control-bg, transparent);
  color: var(--theme-modal-text, var(--theme-text-muted, #94a3b8));
  cursor: pointer;
}

.provider-manager-close:hover {
  background: var(--theme-modal-active-bg, var(--theme-surface-panel-hover, #1e293b));
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
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
  border: 1px solid var(--theme-card-border, var(--theme-modal-border, var(--theme-border-muted, rgba(71, 85, 105, 0.42))));
  border-radius: 10px;
  background: var(--theme-card-bg, var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(2, 6, 23, 0.45))));
}

.provider-manager-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: var(--theme-tab-bg, var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.7))));
  color: var(--theme-tab-text, var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8)));
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  padding: 8px 12px;
  cursor: pointer;
}

.provider-manager-tab.is-active {
  background: var(--theme-tab-active-bg, var(--theme-modal-active-bg, var(--theme-surface-panel-active, rgba(30, 64, 175, 0.45))));
  color: var(--theme-tab-active-text, var(--theme-modal-active-text, var(--theme-text-primary, #e2e8f0)));
}

.provider-manager-feedback {
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 12px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
}

.provider-manager-feedback.is-info {
  background: var(--theme-modal-control-bg, var(--theme-surface-panel-hover, rgba(30, 41, 59, 0.85)));
  color: var(--theme-modal-text, var(--theme-text-secondary, #cbd5e1));
}

.provider-manager-feedback.is-success {
  background: var(--theme-surface-success-soft, rgba(20, 83, 45, 0.24));
  border-color: color-mix(in srgb, var(--theme-status-success, #86efac) 35%, transparent);
  color: var(--theme-text-success, #bbf7d0);
}

.provider-manager-feedback.is-error {
  background: var(--theme-surface-danger-soft, rgba(127, 29, 29, 0.22));
  border-color: color-mix(in srgb, var(--theme-status-danger, #fca5a5) 35%, transparent);
  color: var(--theme-text-danger, #fecaca);
}

.provider-card,
.model-group,
.model-row {
  border: 1px solid var(--theme-card-border, var(--theme-modal-border, var(--theme-border-default, rgba(51, 65, 85, 0.8))));
  border-radius: 12px;
  background: var(--theme-card-bg, var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(2, 6, 23, 0.46))));
}

.section-eyebrow {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #64748b));
}

.section-heading {
  margin-top: 4px;
  font-size: 14px;
  font-weight: 700;
  color: var(--theme-modal-text, var(--theme-text-primary, #f8fafc));
}

.section-heading-count {
  font-size: 14px;
  font-weight: 500;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.section-meta {
  margin-top: 4px;
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
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
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, rgba(51, 65, 85, 0.8)));
  border-radius: 12px;
  background: var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(2, 6, 23, 0.46)));
  overflow: hidden;
}

.provider-empty-state {
  padding: 18px 14px;
  font-size: 12px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.provider-list-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 54px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--theme-modal-border, var(--theme-border-default, rgba(51, 65, 85, 0.8)));
}

.provider-list-row:last-child {
  border-bottom: none;
}

.provider-list-row-main {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.provider-list-row-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}

.provider-list-row-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1.05;
}

.provider-list-row-actions {
  flex: 0 0 178px;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 6px;
}

.provider-note {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
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
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 8px;
  background: var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72)));
  color: var(--theme-modal-text, var(--theme-text-secondary, #cbd5e1));
  font-size: 12px;
  font-family: inherit;
  padding: 10px 12px;
  cursor: pointer;
}

.provider-view-all-toggle:hover {
  border-color: var(--theme-modal-accent, var(--theme-border-strong, #475569));
  background: var(--theme-modal-active-bg, var(--theme-surface-panel-hover, rgba(30, 41, 59, 0.92)));
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
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
}

.provider-view-all-toggle-meta {
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.provider-view-all-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.provider-view-all-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.provider-mini-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 42px;
  padding: 6px 8px;
  border: 1px solid var(--theme-card-border, var(--theme-modal-border, var(--theme-border-default, rgba(51, 65, 85, 0.8))));
  border-radius: 10px;
  background: var(--theme-card-bg, var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(2, 6, 23, 0.46))));
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
  text-align: left;
}

.provider-mini-row.is-disabled {
  opacity: 0.72;
}

.provider-mini-row-title {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 0;
  line-height: 1.02;
}

.provider-mini-row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 700;
  color: var(--theme-modal-text, var(--theme-text-primary, #f8fafc));
}

.provider-mini-row-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #64748b));
}

.provider-mini-row-status {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.provider-mini-row-action {
  min-height: 28px;
  padding: 4px 9px;
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
  border-color: var(--theme-modal-accent, var(--theme-border-accent, rgba(96, 165, 250, 0.55)));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--theme-modal-accent, var(--theme-accent-primary, #3b82f6)) 35%, transparent);
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
  color: var(--theme-modal-text, var(--theme-text-primary, #f8fafc));
}

.provider-id,
.model-id {
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #64748b));
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
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  font-size: 11px;
}

.status-badge.is-enabled {
  border-color: color-mix(in srgb, var(--theme-status-success, #86efac) 35%, transparent);
  color: var(--theme-text-success, #bbf7d0);
}

.status-badge.is-disabled {
  border-color: color-mix(in srgb, var(--theme-status-danger, #fca5a5) 35%, transparent);
  color: var(--theme-text-danger, #fecaca);
}

.status-badge.is-current {
  border-color: var(--theme-badge-border, var(--theme-modal-border, var(--theme-border-default, #334155)));
  color: var(--theme-badge-text, var(--theme-modal-text, var(--theme-text-secondary, #cbd5e1)));
  background: var(--theme-badge-bg, var(--theme-modal-control-bg, var(--theme-surface-chip, rgba(15, 23, 42, 0.78))));
}

.status-badge.is-warning {
  border-color: color-mix(in srgb, var(--theme-status-warning, #fcd34d) 35%, transparent);
  color: var(--theme-text-warning, #fde68a);
}

.status-badge.is-muted,
.auth-chip,
.capability-chip {
  color: var(--theme-badge-text, var(--theme-modal-text, var(--theme-text-secondary, #cbd5e1)));
  background: var(--theme-badge-bg, var(--theme-modal-control-bg, var(--theme-surface-chip, rgba(15, 23, 42, 0.78))));
}

.provider-stats,
.model-meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.provider-stats.compact {
  gap: 7px;
  line-height: 1.05;
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--theme-action-button-border, var(--theme-modal-border, var(--theme-border-default, #334155)));
  border-radius: 8px;
  background: var(--theme-action-button-bg, var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.82))));
  color: var(--theme-action-button-text, var(--theme-modal-text, var(--theme-text-primary, #e2e8f0)));
  font-size: 12px;
  font-family: inherit;
  padding: 7px 10px;
  cursor: pointer;
}

.ghost-action:hover {
  border-color: var(--theme-action-button-border, var(--theme-modal-accent, var(--theme-border-strong, #475569)));
  background: var(--theme-action-button-hover-bg, var(--theme-modal-active-bg, var(--theme-surface-panel-hover, rgba(30, 41, 59, 0.92))));
}

.ghost-action:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.ghost-action.danger {
  color: var(--theme-text-danger, #fca5a5);
}

.ghost-action.secondary {
  border-color: var(--theme-action-button-accent-border, var(--theme-modal-accent, var(--theme-border-accent, rgba(96, 165, 250, 0.35))));
  background: var(--theme-action-button-accent-bg, color-mix(in srgb, var(--theme-modal-accent, var(--theme-accent-primary, #3b82f6)) 18%, transparent));
  color: var(--theme-action-button-accent-text, var(--theme-modal-active-text, var(--theme-text-primary, #dbeafe)));
}

.provider-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--theme-modal-text, var(--theme-text-secondary, #cbd5e1));
  font-size: 12px;
}

.provider-toggle.compact {
  flex: 0 0 auto;
  justify-content: flex-end;
  gap: 6px;
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
  background: var(--theme-toggle-track, var(--theme-modal-border, var(--theme-border-default, rgba(51, 65, 85, 0.95))));
  border: 1px solid var(--theme-toggle-track-border, var(--theme-modal-border, var(--theme-border-muted, rgba(100, 116, 139, 0.55))));
  position: relative;
  transition: background 0.18s ease;
}

.toggle-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--theme-toggle-thumb, var(--theme-modal-text, var(--theme-text-muted, #94a3b8)));
  transition:
    transform 0.2s,
    background 0.2s;
}

.toggle-input:checked + .toggle-track {
  background: var(--theme-toggle-active-track, var(--theme-modal-accent, var(--theme-accent-primary, #3b82f6)));
}

.toggle-input:checked + .toggle-track::after {
  transform: translateX(16px);
  background: var(--theme-toggle-active-thumb, var(--theme-modal-active-text, var(--theme-text-inverse, #fff)));
}

.model-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0;
}

.model-search-field {
  flex: 1 1 260px;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 0 12px;
  border: 1px solid var(--theme-search-border, var(--theme-modal-border, var(--theme-border-default, #334155)));
  border-radius: 10px;
  background: var(--theme-search-bg, var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.82))));
  color: var(--theme-search-icon, var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8)));
}

.model-search-field input {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--theme-search-text, var(--theme-modal-text, var(--theme-text-primary, #e2e8f0)));
  font-size: 12px;
  font-family: inherit;
}

.model-search-field input::placeholder {
  color: var(--theme-search-placeholder, var(--theme-modal-text-muted, var(--theme-text-muted, #64748b)));
}

.model-toolbar-stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.models-empty {
  padding: 30px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--theme-empty-state-text, var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8)));
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
  border-color: var(--theme-modal-accent, var(--theme-border-accent, rgba(96, 165, 250, 0.45)));
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

  .provider-mini-row {
    align-items: flex-start;
  }

  .provider-view-all-list {
    grid-template-columns: 1fr;
  }

  .provider-mini-row-status {
    align-items: flex-end;
    flex-direction: column;
    gap: 6px;
  }
}
</style>
