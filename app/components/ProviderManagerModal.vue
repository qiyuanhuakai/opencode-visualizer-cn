<template>
  <dialog
    ref="dialogRef"
    class="provider-manager-backdrop"
    @close="$emit('close')"
    @cancel.prevent
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

        <template v-if="showCustomProviderForm">
          <form class="custom-provider-form" @submit.prevent="submitCustomProvider">
            <button type="button" class="provider-back-action" @click="closeCustomProviderForm">
              <Icon icon="lucide:arrow-left" :width="14" :height="14" />
              {{ $t('providerManager.custom.back') }}
            </button>

            <div class="custom-provider-heading">
              <div class="custom-provider-icon">
                <Icon icon="lucide:sparkles" :width="20" :height="20" />
              </div>
              <div>
                <div class="section-heading custom-provider-title">{{ $t('providerManager.custom.title') }}</div>
                <p class="custom-provider-description">
                  {{ $t('providerManager.custom.description') }}
                </p>
              </div>
            </div>

            <label class="custom-provider-field">
              <span>{{ $t('providerManager.custom.fields.providerId.label') }}</span>
              <input
                v-model="customProviderForm.providerID"
                type="text"
                :placeholder="$t('providerManager.custom.fields.providerId.placeholder')"
                @input="customProviderErrors.providerID = ''"
              />
              <small :class="{ 'is-error': customProviderErrors.providerID }">
                {{ customProviderErrors.providerID || $t('providerManager.custom.fields.providerId.description') }}
              </small>
            </label>

            <label class="custom-provider-field">
              <span>{{ $t('providerManager.custom.fields.name.label') }}</span>
              <input
                v-model="customProviderForm.name"
                type="text"
                :placeholder="$t('providerManager.custom.fields.name.placeholder')"
                @input="customProviderErrors.name = ''"
              />
              <small v-if="customProviderErrors.name" class="is-error">{{ customProviderErrors.name }}</small>
            </label>

            <label class="custom-provider-field">
              <span>{{ $t('providerManager.custom.fields.baseUrl.label') }}</span>
              <input
                v-model="customProviderForm.baseURL"
                type="url"
                :placeholder="$t('providerManager.custom.fields.baseUrl.placeholder')"
                @input="customProviderErrors.baseURL = ''"
              />
              <small v-if="customProviderErrors.baseURL" class="is-error">{{ customProviderErrors.baseURL }}</small>
            </label>

            <label class="custom-provider-field">
              <span>{{ $t('providerManager.custom.fields.apiKey.label') }}</span>
              <input
                v-model="customProviderForm.apiKey"
                type="text"
                :placeholder="$t('providerManager.custom.fields.apiKey.placeholder')"
              />
              <small>{{ $t('providerManager.custom.fields.apiKey.description') }}</small>
            </label>

            <div class="custom-provider-rows">
              <div class="custom-provider-row-header">{{ $t('providerManager.custom.models.label') }}</div>
              <div
                v-for="(model, index) in customProviderForm.models"
                :key="model.row"
                class="custom-provider-row"
              >
                <label>
                  <span class="sr-only">{{ $t('providerManager.custom.models.id.label') }}</span>
                  <input
                    v-model="model.id"
                    type="text"
                    :placeholder="$t('providerManager.custom.models.id.placeholder')"
                    @input="model.err.id = ''"
                  />
                  <small v-if="model.err.id" class="is-error">{{ model.err.id }}</small>
                </label>
                <label>
                  <span class="sr-only">{{ $t('providerManager.custom.models.name.label') }}</span>
                  <input
                    v-model="model.name"
                    type="text"
                    :placeholder="$t('providerManager.custom.models.name.placeholder')"
                    @input="model.err.name = ''"
                  />
                  <small v-if="model.err.name" class="is-error">{{ model.err.name }}</small>
                </label>
                <button
                  type="button"
                  class="custom-provider-remove"
                  :title="$t('providerManager.custom.models.remove')"
                  :disabled="customProviderForm.models.length <= 1"
                  @click="removeCustomModel(index)"
                >
                  <Icon icon="lucide:trash-2" :width="14" :height="14" />
                </button>
              </div>
              <button type="button" class="ghost-action custom-provider-add" @click="addCustomModel">
                <Icon icon="lucide:plus" :width="13" :height="13" />
                {{ $t('providerManager.custom.models.add') }}
              </button>
            </div>

            <div class="custom-provider-rows">
              <div class="custom-provider-row-header">{{ $t('providerManager.custom.headers.label') }}</div>
              <div
                v-for="(header, index) in customProviderForm.headers"
                :key="header.row"
                class="custom-provider-row"
              >
                <label>
                  <span class="sr-only">{{ $t('providerManager.custom.headers.key.label') }}</span>
                  <input
                    v-model="header.key"
                    type="text"
                    :placeholder="$t('providerManager.custom.headers.key.placeholder')"
                    @input="header.err.key = ''"
                  />
                  <small v-if="header.err.key" class="is-error">{{ header.err.key }}</small>
                </label>
                <label>
                  <span class="sr-only">{{ $t('providerManager.custom.headers.value.label') }}</span>
                  <input
                    v-model="header.value"
                    type="text"
                    :placeholder="$t('providerManager.custom.headers.value.placeholder')"
                    @input="header.err.value = ''"
                  />
                  <small v-if="header.err.value" class="is-error">{{ header.err.value }}</small>
                </label>
                <button
                  type="button"
                  class="custom-provider-remove"
                  :title="$t('providerManager.custom.headers.remove')"
                  :disabled="customProviderForm.headers.length <= 1"
                  @click="removeCustomHeader(index)"
                >
                  <Icon icon="lucide:trash-2" :width="14" :height="14" />
                </button>
              </div>
              <button type="button" class="ghost-action custom-provider-add" @click="addCustomHeader">
                <Icon icon="lucide:plus" :width="13" :height="13" />
                {{ $t('providerManager.custom.headers.add') }}
              </button>
            </div>

            <button type="submit" class="ghost-action secondary custom-provider-submit" :disabled="busyProviderId === CUSTOM_PROVIDER_BUSY_ID">
              {{ $t('providerManager.custom.submit') }}
            </button>
          </form>
        </template>

        <template v-else-if="activeTab === 'providers'">
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
                        :disabled="busyProviderId === provider.id || isBackendManagedProvider(provider)"
                        :title="isBackendManagedProvider(provider) ? $t('providerManager.messages.backendManagedProvider') : undefined"
                        @change="toggleProvider(provider.id, ($event.target as HTMLInputElement).checked)"
                      />
                      <span class="toggle-track" />
                    </label>
                    <button
                      type="button"
                      class="ghost-action danger"
                      :disabled="!canDisconnectProvider(provider) || busyProviderId === provider.id"
                      @click="disconnectProvider(provider)"
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
                <div class="custom-provider-entry">
                  <span class="custom-provider-entry-icon">
                    <Icon icon="lucide:sparkles" :width="16" :height="16" />
                  </span>
                  <span class="custom-provider-entry-text">
                    <span>{{ $t('providerManager.custom.title') }}</span>
                    <small>{{ $t('providerManager.custom.entryDescription') }}</small>
                  </span>
                  <button
                    type="button"
                    class="ghost-action provider-mini-row-action"
                    :disabled="!supportsProviderConfigUpdates()"
                    :title="!supportsProviderConfigUpdates() ? $t('providerManager.messages.unsupportedBackendFeature', { feature: 'custom providers' }) : undefined"
                    @click="openCustomProviderForm"
                  >
                    {{ $t('providerManager.actions.connect') }}
                  </button>
                </div>
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
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { getActiveBackendAdapter } from '../backends/registry';
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
  prompts?: ProviderAuthPrompt[];
};

type ProviderAuthPromptOption = string | {
  hint?: string;
  label?: string;
  value?: string;
};

type ProviderAuthPromptCondition = {
  key: string;
  op: 'eq' | 'neq';
  value: string;
};

type ProviderAuthPrompt = {
  type: 'text' | 'select';
  key: string;
  message?: string;
  placeholder?: string;
  options?: ProviderAuthPromptOption[];
  when?: ProviderAuthPromptCondition;
};

type ProviderAuthAuthorization = {
  url: string;
  method: 'auto' | 'code';
  instructions: string;
};

type CustomProviderModelRow = {
  row: string;
  id: string;
  name: string;
  err: {
    id?: string;
    name?: string;
  };
};

function backend() {
  return getActiveBackendAdapter();
}

function requireBackendMethod<T>(method: T | undefined, name: string): T {
  if (!method) throw new Error(String(t('providerManager.messages.unsupportedBackendFeature', { feature: name })));
  return method;
}

type CustomProviderHeaderRow = {
  row: string;
  key: string;
  value: string;
  err: {
    key?: string;
    value?: string;
  };
};

type CustomProviderConfig = {
  npm: string;
  name: string;
  env?: string[];
  options: {
    baseURL: string;
    headers?: Record<string, string>;
  };
  models: Record<string, { name: string }>;
};

type CustomProviderValidationResult = {
  providerID: string;
  name: string;
  key?: string;
  config: CustomProviderConfig;
};

const POPULAR_PROVIDER_IDS = ['opencode', 'opencode-go', 'openai', 'github-copilot', 'anthropic', 'google'];
const CUSTOM_PROVIDER_NPM = '@ai-sdk/openai-compatible';
const CUSTOM_PROVIDER_BUSY_ID = '__custom_provider__';
const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

const DEFAULT_API_AUTH_METHOD: ProviderAuthMethod = {
  type: 'api',
  label: 'API key',
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

const { t } = useI18n();

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
const showCustomProviderForm = ref(false);
const customProviderRowCounter = ref(0);
const customProviderForm = ref({
  providerID: '',
  name: '',
  baseURL: '',
  apiKey: '',
  models: [createCustomModelRow()],
  headers: [createCustomHeaderRow()],
});
const customProviderErrors = ref({
  providerID: '',
  name: '',
  baseURL: '',
});

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
      closeCustomProviderForm();
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

function nextCustomProviderRowId() {
  customProviderRowCounter.value += 1;
  return `custom-row-${customProviderRowCounter.value}`;
}

function createCustomModelRow(): CustomProviderModelRow {
  return { row: nextCustomProviderRowId(), id: '', name: '', err: {} };
}

function createCustomHeaderRow(): CustomProviderHeaderRow {
  return { row: nextCustomProviderRowId(), key: '', value: '', err: {} };
}

function resetCustomProviderForm() {
  customProviderErrors.value = { providerID: '', name: '', baseURL: '' };
  customProviderForm.value = {
    providerID: '',
    name: '',
    baseURL: '',
    apiKey: '',
    models: [createCustomModelRow()],
    headers: [createCustomHeaderRow()],
  };
}

function openCustomProviderForm() {
  resetCustomProviderForm();
  feedbackMessage.value = '';
  showCustomProviderForm.value = true;
}

function closeCustomProviderForm() {
  showCustomProviderForm.value = false;
}

function addCustomModel() {
  customProviderForm.value.models.push(createCustomModelRow());
}

function removeCustomModel(index: number) {
  if (customProviderForm.value.models.length <= 1) return;
  customProviderForm.value.models.splice(index, 1);
}

function addCustomHeader() {
  customProviderForm.value.headers.push(createCustomHeaderRow());
}

function removeCustomHeader(index: number) {
  if (customProviderForm.value.headers.length <= 1) return;
  customProviderForm.value.headers.splice(index, 1);
}

async function fetchAuthMethods() {
  try {
    const listProviderAuthMethods = backend().listProviderAuthMethods;
    if (!listProviderAuthMethods) {
      authMethods.value = {};
      return;
    }
    const data = (await listProviderAuthMethods()) as Record<string, ProviderAuthMethod[]>;
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
  const methods = authMethods.value[providerId];
  return methods && methods.length > 0 ? methods : [DEFAULT_API_AUTH_METHOD];
}

function isProviderDisconnected(provider: ProviderInfo) {
  return !connectedProviderIdSet.value.has(provider.id);
}

function isBackendManagedProvider(provider: ProviderInfo) {
  return provider.source === 'codex-app-server';
}

function supportsProviderConfigUpdates() {
  const active = backend();
  return Boolean(active.updateGlobalConfig && active.setProviderAuth);
}

function canDisconnectProvider(provider: ProviderInfo) {
  return !isProviderDisconnected(provider) && provider.source !== 'env' && !isBackendManagedProvider(provider);
}

function isConfigBackedProvider(provider: ProviderInfo) {
  return provider.source === 'config' || provider.source === 'custom' || Boolean(props.providerConfig?.provider?.[provider.id]);
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
  const note = t(`providerManager.providerNotes.${providerId}`);
  return note === `providerManager.providerNotes.${providerId}` ? '' : note;
}

function formatCount(value?: number) {
  if (!value || !Number.isFinite(value)) return '—';
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function validationMessage(key: string) {
  return String(key);
}

function validateCustomProvider() {
  const providerID = customProviderForm.value.providerID.trim();
  const name = customProviderForm.value.name.trim();
  const baseURL = customProviderForm.value.baseURL.trim();
  const apiKey = customProviderForm.value.apiKey.trim();
  const env = apiKey.match(/^\{env:([^}]+)\}$/)?.[1]?.trim();
  const disabledProviders = normalizeProviderIds(props.providerConfig?.disabled_providers);
  const existingProviderIds = new Set(props.providers.map((provider) => provider.id));
  const isDisabledExistingProvider = disabledProviders.includes(providerID);

  customProviderErrors.value = {
    providerID: !providerID
      ? validationMessage('providerManager.custom.errors.providerIdRequired')
      : !CUSTOM_PROVIDER_ID_PATTERN.test(providerID)
        ? validationMessage('providerManager.custom.errors.providerIdFormat')
        : existingProviderIds.has(providerID) && !isDisabledExistingProvider
          ? validationMessage('providerManager.custom.errors.providerIdExists')
          : '',
    name: name ? '' : validationMessage('providerManager.custom.errors.nameRequired'),
    baseURL: !baseURL
      ? validationMessage('providerManager.custom.errors.baseUrlRequired')
      : !/^https?:\/\//.test(baseURL)
        ? validationMessage('providerManager.custom.errors.baseUrlFormat')
        : '',
  };

  const seenModels = new Set<string>();
  customProviderForm.value.models.forEach((model) => {
    const modelId = model.id.trim();
    model.err.id = !modelId
      ? validationMessage('providerManager.custom.errors.required')
      : seenModels.has(modelId)
        ? validationMessage('providerManager.custom.errors.duplicate')
        : '';
    if (modelId) seenModels.add(modelId);
    model.err.name = model.name.trim() ? '' : validationMessage('providerManager.custom.errors.required');
  });

  const seenHeaders = new Set<string>();
  customProviderForm.value.headers.forEach((header) => {
    const key = header.key.trim();
    const value = header.value.trim();
    if (!key && !value) {
      header.err = {};
      return;
    }
    const normalizedKey = key.toLowerCase();
    header.err.key = !key
      ? validationMessage('providerManager.custom.errors.required')
      : seenHeaders.has(normalizedKey)
        ? validationMessage('providerManager.custom.errors.duplicate')
        : '';
    if (key) seenHeaders.add(normalizedKey);
    header.err.value = value ? '' : validationMessage('providerManager.custom.errors.required');
  });

  const hasFieldErrors = Boolean(
    customProviderErrors.value.providerID ||
    customProviderErrors.value.name ||
    customProviderErrors.value.baseURL,
  );
  const hasModelErrors = customProviderForm.value.models.some((model) => model.err.id || model.err.name);
  const hasHeaderErrors = customProviderForm.value.headers.some((header) => header.err.key || header.err.value);
  if (hasFieldErrors || hasModelErrors || hasHeaderErrors) return null;

  const headers = Object.fromEntries(
    customProviderForm.value.headers
      .map((header) => ({ key: header.key.trim(), value: header.value.trim() }))
      .filter((header) => header.key && header.value)
      .map((header) => [header.key, header.value]),
  );
  return {
    providerID,
    name,
    key: apiKey && !env ? apiKey : undefined,
    config: {
      npm: CUSTOM_PROVIDER_NPM,
      name,
      ...(env ? { env: [env] } : {}),
      options: {
        baseURL,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
      models: Object.fromEntries(
        customProviderForm.value.models.map((model) => [model.id.trim(), { name: model.name.trim() }]),
      ),
    },
  } satisfies CustomProviderValidationResult;
}

async function submitCustomProvider() {
  const result = validateCustomProvider();
  if (!result) {
    customProviderErrors.value = {
      providerID: customProviderErrors.value.providerID ? String(t(customProviderErrors.value.providerID)) : '',
      name: customProviderErrors.value.name ? String(t(customProviderErrors.value.name)) : '',
      baseURL: customProviderErrors.value.baseURL ? String(t(customProviderErrors.value.baseURL)) : '',
    };
    customProviderForm.value.models.forEach((model) => {
      model.err.id = model.err.id ? String(t(model.err.id)) : '';
      model.err.name = model.err.name ? String(t(model.err.name)) : '';
    });
    customProviderForm.value.headers.forEach((header) => {
      header.err.key = header.err.key ? String(t(header.err.key)) : '';
      header.err.value = header.err.value ? String(t(header.err.value)) : '';
    });
    return;
  }

  busyProviderId.value = CUSTOM_PROVIDER_BUSY_ID;
  try {
    const updateGlobalConfig = requireBackendMethod(backend().updateGlobalConfig, 'global config updates');
    if (result.key) {
      const setProviderAuth = requireBackendMethod(backend().setProviderAuth, 'provider auth');
      await setProviderAuth(result.providerID, { type: 'api', key: result.key });
    }
    const disabledProviders = normalizeProviderIds(props.providerConfig?.disabled_providers)
      .filter((providerId) => providerId !== result.providerID);
    const nextConfig = (await updateGlobalConfig({
      provider: {
        ...props.providerConfig?.provider,
        [result.providerID]: result.config,
      },
      disabled_providers: disabledProviders,
    })) as ProviderConfigState;
    emit('config-updated', nextConfig ?? {});
    emit('providers-changed');
    setFeedback(t('providerManager.messages.connected', { name: result.name }), 'success');
    closeCustomProviderForm();
    resetCustomProviderForm();
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    busyProviderId.value = '';
  }
}

async function pickAuthMethod(providerId: string) {
  const methods = providerAuthSummary(providerId);
  if (methods.length === 1) return { method: methods[0], index: 0 };
  const options = methods.map((method, index) => `${index + 1}. ${method.label}`).join('\n');
  const raw = showPrompt ? await showPrompt(t('providerManager.prompts.selectAuthMethod', { providerId }) + '\n' + options, '1') : null;
  if (!raw) return null;
  const index = Number(raw) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= methods.length) return null;
  return { method: methods[index], index };
}

function promptOptionLabel(option: ProviderAuthPromptOption) {
  return typeof option === 'string' ? option : (option.label?.trim() || option.value?.trim() || '');
}

function promptOptionValue(option: ProviderAuthPromptOption) {
  return typeof option === 'string' ? option : (option.value?.trim() || option.label?.trim() || '');
}

function shouldShowAuthPrompt(prompt: ProviderAuthPrompt, inputs: Record<string, string>) {
  if (!prompt.when) return true;
  const actual = inputs[prompt.when.key];
  if (actual === undefined) return false;
  return prompt.when.op === 'eq' ? actual === prompt.when.value : actual !== prompt.when.value;
}

async function collectAuthPromptInputs(
  provider: ProviderInfo,
  method: ProviderAuthMethod,
) {
  const prompts = method.prompts ?? [];
  const inputs: Record<string, string> = {};
  for (const prompt of prompts) {
    if (!prompt.key || !shouldShowAuthPrompt(prompt, inputs)) continue;
    const title = prompt.message?.trim() || t('providerManager.prompts.enterValueForProvider', { key: prompt.key, providerName: provider.name?.trim() || provider.id });
    if (prompt.type === 'select') {
      const options = (prompt.options ?? [])
        .map((option) => ({ label: promptOptionLabel(option), value: promptOptionValue(option) }))
        .filter((option) => option.value.length > 0);
      if (options.length === 0) continue;
      const optionText = options.map((option, index) => `${index + 1}. ${option.label || option.value}`).join('\n');
      const raw = showPrompt ? await showPrompt(`${title}:\n${optionText}`, '1') : null;
      if (!raw) return null;
      const index = Number(raw) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= options.length) return null;
      inputs[prompt.key] = options[index].value;
      continue;
    }

    const value = showPrompt ? await showPrompt(title, prompt.placeholder) : null;
    if (!value) return null;
    inputs[prompt.key] = value.trim();
  }
  return inputs;
}

async function toggleProvider(providerId: string, nextEnabled: boolean) {
  const provider = props.providers.find((item) => item.id === providerId);
  if (provider && isBackendManagedProvider(provider)) {
    setFeedback(t('providerManager.messages.backendManagedProvider'), 'info');
    return;
  }
  busyProviderId.value = providerId;
  try {
    const updateGlobalConfig = requireBackendMethod(backend().updateGlobalConfig, 'global config updates');
    const result = (await updateGlobalConfig(
      buildProviderDisabledPatch(props.providerConfig, providerId, nextEnabled),
    )) as ProviderConfigState;
    emit('config-updated', result ?? {});
    setFeedback(
      nextEnabled
        ? t('providerManager.messages.providerEnabled', { providerId })
        : t('providerManager.messages.providerDisabled', { providerId }),
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
    nextEnabled ? t('providerManager.messages.modelEnabled', { modelKey }) : t('providerManager.messages.modelDisabled', { modelKey }),
    'success',
  );
}

async function connectProvider(provider: ProviderInfo) {
  if (isBackendManagedProvider(provider)) {
    setFeedback(t('providerManager.messages.backendManagedProvider'), 'info');
    return;
  }
  const picked = await pickAuthMethod(provider.id);
  if (!picked) return;
  busyProviderId.value = provider.id;
  try {
    if (picked.method.type === 'api') {
      const key = showPrompt ? await showPrompt(t('providerManager.prompts.enterApiKey', { providerName: provider.name?.trim() || provider.id })) : null;
      if (!key) return;
      const trimmedKey = key.trim();
      const setProviderAuth = requireBackendMethod(backend().setProviderAuth, 'provider auth');
      await setProviderAuth(provider.id, { type: 'api', key: trimmedKey });
      emit('providers-changed');
    setFeedback(t('providerManager.messages.connected', { name: provider.id }), 'success');
      return;
    }

    const inputs = await collectAuthPromptInputs(provider, picked.method);
    if (!inputs) return;
    const authorizeProviderOAuth = requireBackendMethod(backend().authorizeProviderOAuth, 'provider OAuth authorization');
    const authorization = (await authorizeProviderOAuth(provider.id, {
      method: picked.index,
      inputs,
    })) as ProviderAuthAuthorization;
    if (authorization?.url) {
      window.open(authorization.url, '_blank', 'noopener,noreferrer');
    }
    if (authorization?.method === 'code') {
      const code = showPrompt ? await showPrompt(authorization.instructions || t('providerManager.prompts.pasteAuthCode', { providerId: provider.id })) : null;
      if (!code) return;
      const completeProviderOAuth = requireBackendMethod(backend().completeProviderOAuth, 'provider OAuth completion');
      await completeProviderOAuth(provider.id, {
        method: picked.index,
        code: code.trim(),
      });
    } else {
      const confirmed = showConfirm ? await showConfirm(
        authorization?.instructions || t('providerManager.prompts.completeOAuth', { providerId: provider.id }),
      ) : true;
      if (!confirmed) return;
      const completeProviderOAuth = requireBackendMethod(backend().completeProviderOAuth, 'provider OAuth completion');
      await completeProviderOAuth(provider.id, {
        method: picked.index,
      });
    }
    emit('providers-changed');
    setFeedback(t('providerManager.messages.connected', { name: provider.id }), 'success');
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    busyProviderId.value = '';
  }
}

async function disconnectProvider(provider: ProviderInfo) {
  if (isBackendManagedProvider(provider)) {
    setFeedback(t('providerManager.messages.backendManagedProvider'), 'info');
    return;
  }
  const providerId = provider.id;
  if (!providerId) return;
    const confirmed = showConfirm ? await showConfirm(t('providerManager.confirm.disconnect', { providerId })) : true;
  if (!confirmed) return;
  busyProviderId.value = providerId;
  try {
    const deleteProviderAuth = requireBackendMethod(backend().deleteProviderAuth, 'provider auth deletion');
    if (isConfigBackedProvider(provider)) {
      const updateGlobalConfig = requireBackendMethod(backend().updateGlobalConfig, 'global config updates');
      await deleteProviderAuth(providerId).catch(() => undefined);
      const result = (await updateGlobalConfig(
        buildProviderDisabledPatch(props.providerConfig, providerId, false),
      )) as ProviderConfigState;
      emit('config-updated', result ?? {});
    } else {
      await deleteProviderAuth(providerId);
    }
    emit('providers-changed');
    setFeedback(t('providerManager.messages.disconnected', { providerId }), 'success');
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

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.provider-back-action {
  border: none;
  background: transparent;
  color: inherit;
  font-family: inherit;
  cursor: pointer;
}

.provider-back-action {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 6px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  font-size: 12px;
  padding: 2px 0;
}

.custom-provider-form {
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding-right: 4px;
}

.custom-provider-heading,
.custom-provider-entry {
  display: flex;
  align-items: center;
  gap: 12px;
}

.custom-provider-icon,
.custom-provider-entry-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--theme-modal-text, var(--theme-text-primary, #f8fafc));
}

.custom-provider-title {
  margin-top: 0;
}

.custom-provider-description {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.custom-provider-field,
.custom-provider-row label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  font-size: 12px;
}

.custom-provider-field input,
.custom-provider-row input {
  min-height: 38px;
  width: 100%;
  border: 1px solid var(--theme-search-border, var(--theme-modal-border, var(--theme-border-default, #334155)));
  border-radius: 9px;
  background: var(--theme-search-bg, var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.82))));
  color: var(--theme-search-text, var(--theme-modal-text, var(--theme-text-primary, #e2e8f0)));
  font-size: 13px;
  font-family: inherit;
  padding: 0 12px;
  outline: none;
}

.custom-provider-field input::placeholder,
.custom-provider-row input::placeholder {
  color: var(--theme-search-placeholder, var(--theme-modal-text-muted, var(--theme-text-muted, #64748b)));
}

.custom-provider-field input:focus,
.custom-provider-row input:focus {
  border-color: var(--theme-modal-accent, var(--theme-border-accent, #60a5fa));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-modal-accent, #60a5fa) 24%, transparent);
}

.custom-provider-field small,
.custom-provider-row small {
  min-height: 14px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  font-size: 11px;
}

.custom-provider-field small.is-error,
.custom-provider-row small.is-error {
  color: var(--theme-text-danger, #fecaca);
}

.custom-provider-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.custom-provider-row-header {
  font-size: 12px;
  font-weight: 700;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.custom-provider-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px;
}

.custom-provider-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 38px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  cursor: pointer;
}

.custom-provider-remove:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.custom-provider-add,
.custom-provider-submit {
  align-self: flex-start;
  gap: 6px;
}

.custom-provider-entry {
  width: 100%;
  justify-content: space-between;
  border: 1px solid var(--theme-card-border, var(--theme-modal-border, var(--theme-border-default, rgba(51, 65, 85, 0.8))));
  border-radius: 10px;
  background: var(--theme-card-bg, var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(2, 6, 23, 0.46))));
  padding: 10px;
  text-align: left;
}

.custom-provider-entry-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.custom-provider-entry-text > span {
  font-size: 13px;
  font-weight: 700;
  color: var(--theme-modal-text, var(--theme-text-primary, #f8fafc));
}

.custom-provider-entry-text > small {
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
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
