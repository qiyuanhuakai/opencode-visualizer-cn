<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import ProviderDiscoveryList from '../ProviderDiscoveryList.vue';
import type {
  KimiWebModelObjectWire,
  KimiWebProviderCreateInput,
  KimiWebProviderCatalogEntryWire,
  KimiWebProviderType,
} from '../../utils/kimiWeb';
import {
  KIMI_WEB_ALL_PROVIDERS_BUSY_ID,
  useKimiWebProviders,
  type KimiWebApiKeyChoice,
  type KimiWebManagedProviderEntry,
  type KimiWebManagedProviderModelEntry,
  type KimiWebProviderSaveResult,
  type KimiWebProvidersClient,
  type KimiWebProvidersError,
} from '../../composables/useKimiWebProviders';

const props = defineProps<{ client: KimiWebProvidersClient }>();
const emit = defineEmits<{ (event: 'providers-changed'): void }>();

const { t } = useI18n();
const providerStore = useKimiWebProviders({ client: props.client });
const { providers, catalog, loading, error, busyProviderId } = providerStore;

const showConfirm = inject<((message: string) => Promise<boolean>) | undefined>('showConfirm');

const PROVIDER_TYPES: readonly KimiWebProviderType[] = [
  'kimi',
  'openai',
  'openai_responses',
  'anthropic',
  'google-genai',
  'vertexai',
];
const CAPABILITY_FIELDS = ['attachment', 'reasoning', 'toolcall'] as const;
const URL_PATTERN = /^https?:\/\//u;

type KeyChoiceKind = KimiWebApiKeyChoice['kind'];
type ProviderAction = 'load' | 'create' | 'update' | 'delete' | 'default';
type FormMode = 'closed' | 'create' | 'edit';

const FAILURE_MESSAGE_KEYS: Record<ProviderAction, string> = {
  load: 'kimiWeb.providers.loadFailed',
  create: 'kimiWeb.providers.saveFailed',
  update: 'kimiWeb.providers.saveFailed',
  delete: 'kimiWeb.providers.deleteFailed',
  default: 'kimiWeb.providers.saveFailed',
};

type ModelRow = {
  row: string;
  model: string;
  name: string;
  contextSize: number | '';
  capabilities?: readonly string[];
  err: string;
};

let modelRowCounter = 0;

function createModelRow(
  seed: Partial<
    Pick<KimiWebModelObjectWire, 'model' | 'name' | 'max_context_size' | 'capabilities'>
  > = {},
): ModelRow {
  modelRowCounter += 1;
  return {
    row: `kimi-web-model-row-${modelRowCounter}`,
    model: seed.model ?? '',
    name: seed.name ?? '',
    contextSize: seed.max_context_size ?? '',
    ...(seed.capabilities ? { capabilities: seed.capabilities } : {}),
    err: '',
  };
}

const feedbackMessage = ref('');
const feedbackTone = ref<'info' | 'success' | 'error'>('info');
const feedbackKind = ref<KimiWebProvidersError['kind'] | ''>('');
const formMode = ref<FormMode>('closed');
const editingProviderId = ref('');
const saving = ref(false);
const formErrors = ref({ id: '', baseUrl: '' });
const form = ref({
  id: '',
  type: 'openai' as KimiWebProviderType,
  baseUrl: '',
  keyChoice: 'keep' as KeyChoiceKind,
  keyValue: '',
  models: [createModelRow()],
});

const allBusy = computed(() => busyProviderId.value === KIMI_WEB_ALL_PROVIDERS_BUSY_ID);
const catalogBusy = computed(() => allBusy.value || loading.value);

function isBusy(providerId: string) {
  return busyProviderId.value === providerId || allBusy.value;
}

function isManaged(provider: KimiWebManagedProviderEntry) {
  // kimi's own provider ships with the server and must never be mutated here.
  return provider.id.startsWith('managed:');
}

function statusClass(status: string) {
  if (status === 'connected') return 'is-connected';
  if (status === 'unconfigured') return 'is-unconfigured';
  return 'is-unknown';
}

function capabilityBadges(model: KimiWebManagedProviderModelEntry) {
  return CAPABILITY_FIELDS.filter((field) => model.capabilities[field]);
}

function formatCount(value?: number) {
  if (!value || !Number.isFinite(value)) return '—';
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

function clearFeedback() {
  feedbackKind.value = '';
  feedbackTone.value = 'info';
  feedbackMessage.value = '';
}

function setNotice(message: string) {
  feedbackKind.value = '';
  feedbackTone.value = 'info';
  feedbackMessage.value = message;
}

function setSuccess(action: ProviderAction) {
  feedbackKind.value = '';
  feedbackTone.value = 'success';
  feedbackMessage.value = t(
    action === 'default' ? 'kimiWeb.providers.defaultUpdated' : 'kimiWeb.providers.saved',
  );
  if (action === 'create' || action === 'update') closeForm();
}

function showFailure(action: ProviderAction, failure: KimiWebProvidersError | null) {
  if (!failure) {
    setNotice(t(FAILURE_MESSAGE_KEYS[action]));
    return;
  }
  feedbackKind.value = failure.kind;
  feedbackTone.value = 'error';
  if (failure.kind === 'conflict') {
    feedbackMessage.value = t('kimiWeb.providers.duplicateId');
    return;
  }
  if (failure.kind === 'transport') {
    // kimi could not be reached: name the failed action, not the transport text.
    feedbackMessage.value = t(FAILURE_MESSAGE_KEYS[action]);
    return;
  }
  feedbackMessage.value = failure.message;
}

function applyResult(action: ProviderAction, result: KimiWebProviderSaveResult) {
  if (result.status === 'failed') {
    showFailure(action, result.error);
    return;
  }
  emit('providers-changed');
  if (result.status === 'saved-refresh-failed') {
    setNotice(t('kimiWeb.providers.savedRefreshFailed'));
    return;
  }
  if (action === 'create' || action === 'update' || action === 'default') {
    setSuccess(action);
    return;
  }
  clearFeedback();
}

async function confirmMessage(message: string): Promise<boolean> {
  if (showConfirm) return showConfirm(message);
  return window.confirm(message);
}

async function reload() {
  const ok = await providerStore.load();
  if (!ok) showFailure('load', error.value);
}

async function removeProvider(providerId: string) {
  const confirmed = await confirmMessage(t('kimiWeb.providers.deleteConfirm'));
  if (!confirmed) return;
  applyResult('delete', await providerStore.deleteProvider(providerId));
}

async function setDefault(qualifiedModelId: string) {
  const ok = await providerStore.setDefaultModel(qualifiedModelId);
  if (ok) {
    emit('providers-changed');
    setSuccess('default');
    return;
  }
  showFailure('default', error.value);
}

function openCreateForm() {
  clearFeedback();
  formMode.value = 'create';
  editingProviderId.value = '';
  formErrors.value = { id: '', baseUrl: '' };
  form.value = {
    id: '',
    type: 'openai',
    baseUrl: '',
    keyChoice: 'replace',
    keyValue: '',
    models: [createModelRow()],
  };
}

function openEditForm(provider: KimiWebManagedProviderEntry) {
  clearFeedback();
  formMode.value = 'edit';
  editingProviderId.value = provider.id;
  formErrors.value = { id: '', baseUrl: '' };
  const rows = provider.models.map((model) =>
    createModelRow({
      model: model.id,
      name: model.source?.display_name ?? model.source?.name ?? model.name,
      max_context_size: model.source?.max_context_size ?? model.maxContextSize,
      capabilities: model.source?.capabilities,
    }),
  );
  form.value = {
    id: provider.id,
    type: provider.type,
    baseUrl: provider.baseUrl ?? '',
    keyChoice: 'keep',
    keyValue: '',
    models: rows.length > 0 ? rows : [createModelRow()],
  };
}

function connectCatalogProvider(entry: KimiWebProviderCatalogEntryWire) {
  if (entry.rejected || !entry.wire_type) return;
  openCreateForm();
  form.value.id = entry.id;
  form.value.type = entry.wire_type;
  form.value.baseUrl = entry.base_url ?? '';
  form.value.models = entry.models.map((model) =>
    createModelRow({
      model: model.id,
      name: model.name,
      max_context_size: model.max_context_size,
      capabilities: model.capabilities,
    }),
  );
  if (!form.value.models.length) form.value.models = [createModelRow()];
}

function closeForm() {
  formMode.value = 'closed';
  editingProviderId.value = '';
}

function addModelRow() {
  form.value.models.push(createModelRow());
}

function removeModelRow(index: number) {
  if (form.value.models.length <= 1) return;
  form.value.models.splice(index, 1);
}

function validateForm(): boolean {
  const id = form.value.id.trim();
  const baseUrl = form.value.baseUrl.trim();
  formErrors.value = {
    id: formMode.value === 'create' && !id ? t('kimiWeb.providers.invalidId') : '',
    baseUrl: baseUrl && !URL_PATTERN.test(baseUrl) ? t('kimiWeb.providers.invalidUrl') : '',
  };
  const seen = new Set<string>();
  for (const row of form.value.models) {
    const model = row.model.trim();
    const contextSize = Number(row.contextSize);
    row.err =
      !model || seen.has(model) || !Number.isInteger(contextSize) || contextSize <= 0
        ? t('kimiWeb.providers.invalidModel')
        : '';
    if (model) seen.add(model);
  }
  return (
    !formErrors.value.id && !formErrors.value.baseUrl && form.value.models.every((row) => !row.err)
  );
}

function keyChoiceForSave(): KimiWebApiKeyChoice {
  const value = form.value.keyValue.trim();
  if (form.value.keyChoice === 'remove') return { kind: 'remove' };
  // An empty replace never clears the key: only the explicit remove choice does.
  if (form.value.keyChoice === 'replace' && value) return { kind: 'replace', value };
  return { kind: 'keep' };
}

function modelsForSave(): KimiWebModelObjectWire[] {
  return form.value.models.map((row) => ({
    model: row.model.trim(),
    ...(row.name.trim() ? { display_name: row.name.trim() } : {}),
    max_context_size: Number(row.contextSize),
    ...(row.capabilities ? { capabilities: [...row.capabilities] } : {}),
  }));
}

async function submitForm() {
  if (!validateForm()) return;
  const models = modelsForSave();
  const baseUrl = form.value.baseUrl.trim();
  saving.value = true;
  try {
    if (formMode.value === 'create') {
      const key = keyChoiceForSave();
      const request: KimiWebProviderCreateInput = {
        id: form.value.id.trim(),
        type: form.value.type,
        ...(baseUrl ? { base_url: baseUrl } : {}),
        ...(key.kind === 'replace' ? { api_key: key.value } : {}),
        models,
      };
      applyResult('create', await providerStore.createProvider(request));
      return;
    }
    if (form.value.keyChoice === 'remove') {
      const confirmed = await confirmMessage(t('kimiWeb.providers.removeKeyConfirm'));
      if (!confirmed) return;
    }
    applyResult(
      'update',
      await providerStore.updateProvider(editingProviderId.value, {
        type: form.value.type,
        ...(baseUrl ? { base_url: baseUrl } : {}),
        apiKey: keyChoiceForSave(),
        models,
      }),
    );
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void reload();
});
</script>

<template>
  <section class="kimi-web-provider-manager" :aria-label="$t('kimiWeb.providers.title')">
    <header v-if="formMode !== 'closed'" class="kimi-web-provider-toolbar">
      <button type="button" class="kimi-web-provider-action" @click="closeForm">
        <Icon icon="lucide:arrow-left" :width="14" :height="14" aria-hidden="true" />
        {{ $t('kimiWeb.providers.cancel') }}
      </button>
      <span class="kimi-web-provider-title">{{ formMode === 'create' ? $t('kimiWeb.providers.add') : $t('kimiWeb.providers.edit') }}</span>
    </header>
    <template v-if="formMode === 'closed'">
    <header class="kimi-web-provider-toolbar">
      <div class="kimi-web-provider-heading">
        <span class="kimi-web-provider-title">{{ $t('kimiWeb.providers.installed') }}</span>
        <span class="kimi-web-provider-count">{{ providers.length }}</span>
      </div>
    </header>

    <div
      v-if="feedbackMessage"
      class="kimi-web-provider-feedback"
      :class="[`is-${feedbackTone}`, { 'is-transport': feedbackKind === 'transport' }]"
      :data-error-kind="feedbackKind"
      role="alert"
    >
      {{ feedbackMessage }}
    </div>

    <div v-if="loading && providers.length === 0" class="kimi-web-provider-state" role="status">
      {{ $t('kimiWeb.providers.loading') }}
    </div>
    <div v-else-if="providers.length === 0 && !feedbackMessage" class="kimi-web-provider-state">
      {{ $t('kimiWeb.providers.empty') }}
    </div>

    <div v-else class="kimi-web-provider-list">
      <article
        v-for="provider in providers"
        :key="provider.id"
        class="kimi-web-provider-card"
        :class="{ 'is-managed': isManaged(provider) }"
        :data-provider-id="provider.id"
        :aria-busy="isBusy(provider.id)"
      >
        <div class="kimi-web-provider-card-head">
          <div class="kimi-web-provider-identity">
            <span class="kimi-web-provider-name">{{ provider.name }}</span>
            <span class="kimi-web-provider-id">{{ provider.id }}</span>
          </div>
          <div class="kimi-web-provider-badges">
            <span
              v-if="isManaged(provider)"
              class="kimi-web-provider-badge is-managed"
              :title="$t('kimiWeb.providers.managedReadOnly')"
            >
              {{ $t('kimiWeb.providers.managed') }}
            </span>
            <span class="kimi-web-provider-badge is-type">{{ provider.type }}</span>
            <span class="kimi-web-provider-badge is-status" :class="statusClass(provider.status)">
              {{ provider.status }}
            </span>
          </div>
        </div>

        <div class="kimi-web-provider-meta">
          <span class="kimi-web-provider-meta-base-url" :title="provider.baseUrl">{{
            provider.baseUrl || '—'
          }}</span>
          <span
            v-if="!isManaged(provider)"
            class="kimi-web-provider-meta-key"
            :class="provider.hasApiKey ? 'is-configured' : 'is-missing'"
          >
            {{
              provider.hasApiKey
                ? $t('kimiWeb.providers.keyConfigured')
                : $t('kimiWeb.providers.keyMissing')
            }}
          </span>
          <span
            v-if="provider.defaultModel"
            class="kimi-web-provider-meta-default"
            :title="provider.defaultModel"
          >
            {{ $t('kimiWeb.providers.defaultModel') }}: {{ provider.defaultModel }}
          </span>
        </div>

        <details v-if="provider.models.length > 0" class="kimi-web-provider-model-details">
          <summary>
            {{ $t('kimiWeb.providers.models') }} <span>{{ provider.models.length }}</span>
          </summary>
          <ul class="kimi-web-provider-models">
            <li
              v-for="model in provider.models"
              :key="model.qualifiedId"
              class="kimi-web-provider-model"
              :data-model-id="model.id"
            >
              <div class="kimi-web-provider-model-main">
                <span class="kimi-web-provider-model-name">{{ model.name }}</span>
                <span class="kimi-web-provider-model-id">{{ model.qualifiedId }}</span>
                <span v-if="model.maxContextSize" class="kimi-web-provider-model-context">
                  {{ $t('kimiWeb.providers.contextSize') }}: {{ formatCount(model.maxContextSize) }}
                </span>
              </div>
              <div
                class="kimi-web-provider-model-badges"
                :aria-label="$t('kimiWeb.providers.capabilities')"
              >
                <span
                  v-for="field in capabilityBadges(model)"
                  :key="field"
                  class="kimi-web-provider-capability"
                  :data-capability="field"
                >
                  {{ field }}
                </span>
              </div>
              <button
                type="button"
                class="kimi-web-provider-action"
                :disabled="isBusy(provider.id)"
                @click="setDefault(model.qualifiedId)"
              >
                {{ $t('kimiWeb.providers.setDefault') }}
              </button>
            </li>
          </ul>
        </details>

        <div class="kimi-web-provider-card-actions">
          <button
            type="button"
            class="kimi-web-provider-action"
            :disabled="isBusy(provider.id) || isManaged(provider)"
            :title="isManaged(provider) ? $t('kimiWeb.providers.managedReadOnly') : undefined"
            @click="openEditForm(provider)"
          >
            {{ $t('kimiWeb.providers.edit') }}
          </button>
          <button
            type="button"
            class="kimi-web-provider-action is-danger"
            :disabled="isBusy(provider.id) || isManaged(provider)"
            :title="isManaged(provider) ? $t('kimiWeb.providers.managedReadOnly') : undefined"
            @click="removeProvider(provider.id)"
          >
            {{ $t('kimiWeb.providers.delete') }}
          </button>
        </div>
      </article>
    </div>

    <section class="kimi-web-provider-catalog">
      <header class="kimi-web-provider-catalog-head">
        <span class="kimi-web-provider-title">{{ $t('kimiWeb.providers.catalog') }}</span>
      </header>
      <div class="kimi-web-provider-custom-entry">
        <span class="kimi-web-provider-custom-icon" aria-hidden="true">
          <Icon icon="lucide:sparkles" :width="16" :height="16" />
        </span>
        <span class="kimi-web-provider-custom-copy">
          <strong>{{ $t('providerManager.custom.title') }}</strong>
          <small>{{ $t('providerManager.custom.entryDescription') }}</small>
        </span>
        <button type="button" class="kimi-web-provider-action" @click="openCreateForm">
          {{ $t('providerManager.actions.connect') }}
        </button>
      </div>
      <div v-if="catalog.length === 0" class="kimi-web-provider-state">
        {{ $t('kimiWeb.providers.catalogEmpty') }}
      </div>
      <ProviderDiscoveryList v-else :entries="catalog" v-slot="{ entry, letter }">
        <article
          :data-provider-letter="letter"
          tabindex="-1"
          class="kimi-web-provider-catalog-entry"
          :data-catalog-id="entry.id"
        >
          <div class="kimi-web-provider-catalog-identity">
            <span class="kimi-web-provider-catalog-name" :title="entry.name?.trim() || entry.id">{{
              entry.name?.trim() || entry.id
            }}</span>
            <span class="kimi-web-provider-id" :title="entry.id">{{ entry.id }}</span>
          </div>
          <div class="kimi-web-provider-catalog-meta">
            <span v-if="entry.env_key" class="kimi-web-provider-catalog-env" :title="entry.env_key">
              {{ $t('kimiWeb.providers.environmentKey') }}: {{ entry.env_key }}
            </span>
            <span class="kimi-web-provider-catalog-models">
              {{ $t('kimiWeb.providers.models') }}: {{ entry.models.length }}
            </span>
          </div>
          <button
            type="button"
            class="kimi-web-provider-action"
            :disabled="
              catalogBusy ||
              entry.rejected ||
              !entry.wire_type ||
              providers.some((provider) => provider.id === entry.id)
            "
            :title="entry.reject_reason || undefined"
            @click="connectCatalogProvider(entry)"
          >
            {{ $t('providerManager.actions.connect') }}
          </button>
        </article>
      </ProviderDiscoveryList>
    </section>

    </template>
    <form v-if="formMode !== 'closed'" class="kimi-web-provider-form" @submit.prevent="submitForm">
      <div v-if="feedbackMessage" class="kimi-web-provider-feedback" :class="[`is-${feedbackTone}`, { 'is-transport': feedbackKind === 'transport' }]" :data-error-kind="feedbackKind" role="alert">{{ feedbackMessage }}</div>
      <label class="kimi-web-provider-field">
        <span>{{ $t('kimiWeb.providers.id') }}</span>
        <input v-model="form.id" type="text" :disabled="formMode === 'edit'" />
        <small v-if="formErrors.id" class="is-error">{{ formErrors.id }}</small>
      </label>

      <label class="kimi-web-provider-field">
        <span>{{ $t('kimiWeb.providers.type') }}</span>
        <select v-model="form.type">
          <option v-for="type of PROVIDER_TYPES" :key="type" :value="type">{{ type }}</option>
        </select>
      </label>

      <label class="kimi-web-provider-field">
        <span>{{ $t('kimiWeb.providers.baseUrl') }}</span>
        <input v-model="form.baseUrl" type="text" />
        <small v-if="formErrors.baseUrl" class="is-error">{{ formErrors.baseUrl }}</small>
      </label>

      <fieldset class="kimi-web-provider-key">
        <legend>{{ $t('kimiWeb.providers.apiKey') }}</legend>
        <label v-if="formMode === 'edit'" class="kimi-web-provider-key-choice">
          <input v-model="form.keyChoice" type="radio" value="keep" />
          <span>{{ $t('kimiWeb.providers.keepKey') }}</span>
        </label>
        <label v-if="formMode === 'edit'" class="kimi-web-provider-key-choice">
          <input v-model="form.keyChoice" type="radio" value="replace" />
          <span>{{ $t('kimiWeb.providers.replaceKey') }}</span>
        </label>
        <label v-if="formMode === 'edit'" class="kimi-web-provider-key-choice">
          <input v-model="form.keyChoice" type="radio" value="remove" />
          <span>{{ $t('kimiWeb.providers.removeKey') }}</span>
        </label>
        <input
          v-if="formMode === 'create' || form.keyChoice === 'replace'"
          v-model="form.keyValue"
          class="kimi-web-provider-key-value"
          type="text"
          :aria-label="$t('kimiWeb.providers.apiKey')"
        />
        <small>{{
          formMode === 'edit'
            ? $t('kimiWeb.providers.keyReentryRequired')
            : $t('kimiWeb.providers.keyMemoryOnly')
        }}</small>
      </fieldset>

      <div class="kimi-web-provider-model-rows">
        <div class="kimi-web-provider-row-header">{{ $t('kimiWeb.providers.models') }}</div>
        <div v-for="(row, index) in form.models" :key="row.row" class="kimi-web-provider-model-row">
          <input
            v-model="row.model"
            type="text"
            :aria-label="$t('kimiWeb.providers.modelId')"
            :class="{ 'is-error': row.err }"
          />
          <input v-model="row.name" type="text" :aria-label="$t('kimiWeb.providers.modelName')" />
          <input
            v-model.number="row.contextSize"
            type="number"
            min="1"
            :aria-label="$t('kimiWeb.providers.contextSize')"
            :class="{ 'is-error': row.err }"
          />
          <button
            type="button"
            class="kimi-web-provider-remove"
            :disabled="form.models.length <= 1"
            :aria-label="$t('kimiWeb.providers.removeModel')"
            :title="$t('kimiWeb.providers.removeModel')"
            @click="removeModelRow(index)"
          >
            <Icon icon="lucide:x" :width="13" :height="13" aria-hidden="true" />
          </button>
          <small v-if="row.err" class="is-error">{{ row.err }}</small>
        </div>
        <button type="button" class="kimi-web-provider-action" @click="addModelRow">
          <Icon icon="lucide:plus" :width="13" :height="13" aria-hidden="true" />
          {{ $t('kimiWeb.providers.addModel') }}
        </button>
      </div>

      <div class="kimi-web-provider-form-actions">
        <button
          type="submit"
          class="kimi-web-provider-action is-primary"
          :disabled="
            saving ||
            busyProviderId === (formMode === 'create' ? form.id.trim() : editingProviderId)
          "
        >
          {{ saving ? $t('kimiWeb.providers.saving') : $t('kimiWeb.providers.save') }}
        </button>
        <button type="button" class="kimi-web-provider-action" @click="closeForm">
          {{ $t('kimiWeb.providers.cancel') }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.kimi-web-provider-manager {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-right: var(--space-1);
}

.kimi-web-provider-toolbar,
.kimi-web-provider-catalog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.kimi-web-provider-heading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.kimi-web-provider-title {
  font-size: var(--type-heading);
  font-weight: 700;
  color: var(--theme-modal-text, var(--theme-text-primary, #f8fafc));
}

.kimi-web-provider-count {
  font-size: var(--type-sm);
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.kimi-web-provider-toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.kimi-web-provider-state {
  padding: 14px 12px;
  font-size: var(--type-sm);
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.kimi-web-provider-feedback {
  padding: 10px 12px;
  border-radius: var(--radius-panel);
  font-size: var(--type-sm);
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  background: var(
    --theme-modal-control-bg,
    var(--theme-surface-panel-hover, rgba(30, 41, 59, 0.85))
  );
  color: var(--theme-modal-text, var(--theme-text-secondary, #cbd5e1));
}

.kimi-web-provider-feedback.is-error {
  background: var(--theme-surface-danger-soft, rgba(127, 29, 29, 0.22));
  border-color: color-mix(in srgb, var(--theme-status-danger, #fca5a5) 35%, transparent);
  color: var(--theme-text-danger, #fecaca);
}

.kimi-web-provider-feedback.is-success {
  background: var(--theme-surface-success-soft, rgba(20, 83, 45, 0.24));
  border-color: color-mix(in srgb, var(--theme-status-success, #86efac) 35%, transparent);
  color: var(--theme-text-success, #bbf7d0);
}

.kimi-web-provider-feedback.is-transport {
  border-style: dashed;
}

.kimi-web-provider-list {
  display: grid;
  gap: var(--space-2);
}

.kimi-web-provider-catalog {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.kimi-web-provider-custom-entry {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 10px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: var(--radius-panel);
  background: var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(2, 6, 23, 0.46)));
}

.kimi-web-provider-custom-icon {
  flex: 0 0 auto;
  color: var(--theme-modal-accent, var(--theme-text-accent, #60a5fa));
}

.kimi-web-provider-custom-copy {
  flex: 1 1 auto;
  min-width: 0;
  display: grid;
  gap: 2px;
  color: var(--theme-modal-text, var(--theme-text-primary, #f8fafc));
}

.kimi-web-provider-custom-copy strong {
  font-size: var(--type-body);
  font-weight: 700;
}

.kimi-web-provider-custom-copy small {
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.kimi-web-provider-card,
.kimi-web-provider-catalog-entry {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-1) 8px;
  padding: 8px 10px;
  min-width: 0;
  border: 1px solid
    var(
      --theme-card-border,
      var(--theme-modal-border, var(--theme-border-default, rgba(51, 65, 85, 0.8)))
    );
  border-radius: var(--radius-panel);
  background: var(
    --theme-card-bg,
    var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(2, 6, 23, 0.46)))
  );
}

.kimi-web-provider-card-head {
  grid-column: 1;
}

.kimi-web-provider-card-actions {
  grid-column: 2;
  grid-row: 1 / 3;
}

.kimi-web-provider-meta {
  grid-column: 1;
  min-width: 0;
}

.kimi-web-provider-meta-base-url,
.kimi-web-provider-meta-default {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kimi-web-provider-model-details {
  grid-column: 1 / -1;
  min-width: 0;
}

.kimi-web-provider-model-details summary {
  width: fit-content;
  padding: 4px 0;
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  cursor: pointer;
}

.kimi-web-provider-model-details summary span {
  margin-left: 4px;
}

.kimi-web-provider-catalog-entry {
  padding: 6px 8px;
  min-height: 42px;
}

.kimi-web-provider-catalog-identity,
.kimi-web-provider-catalog-meta {
  grid-column: 1;
}

.kimi-web-provider-catalog-entry > .kimi-web-provider-action {
  grid-column: 2;
  grid-row: 1 / 3;
}

.kimi-web-provider-catalog-name,
.kimi-web-provider-catalog-identity .kimi-web-provider-id,
.kimi-web-provider-catalog-env {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kimi-web-provider-card[aria-busy='true'] {
  border-color: var(--theme-modal-accent, var(--theme-border-accent, rgba(96, 165, 250, 0.55)));
}

.kimi-web-provider-card-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.kimi-web-provider-identity,
.kimi-web-provider-catalog-identity {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1.15;
}

.kimi-web-provider-name,
.kimi-web-provider-catalog-name {
  font-size: var(--type-body);
  font-weight: 700;
  color: var(--theme-modal-text, var(--theme-text-primary, #f8fafc));
  word-break: break-word;
}

.kimi-web-provider-id {
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #64748b));
  word-break: break-all;
}

.kimi-web-provider-badges,
.kimi-web-provider-model-badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.kimi-web-provider-badge,
.kimi-web-provider-capability {
  display: inline-flex;
  align-items: center;
  min-height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  font-size: var(--type-caption);
  color: var(--theme-badge-text, var(--theme-modal-text, var(--theme-text-secondary, #cbd5e1)));
  background: var(
    --theme-badge-bg,
    var(--theme-modal-control-bg, var(--theme-surface-chip, rgba(15, 23, 42, 0.78)))
  );
}

.kimi-web-provider-badge.is-connected {
  border-color: color-mix(in srgb, var(--theme-status-success, #86efac) 35%, transparent);
  color: var(--theme-text-success, #bbf7d0);
}

.kimi-web-provider-badge.is-unconfigured,
.kimi-web-provider-badge.is-managed {
  border-color: color-mix(in srgb, var(--theme-status-warning, #fcd34d) 35%, transparent);
  color: var(--theme-text-warning, #fde68a);
}

.kimi-web-provider-meta,
.kimi-web-provider-catalog-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.kimi-web-provider-catalog-meta {
  flex-wrap: nowrap;
  min-width: 0;
}

.kimi-web-provider-catalog-models {
  flex-shrink: 0;
}

.kimi-web-provider-meta-key.is-configured {
  color: var(--theme-text-success, #bbf7d0);
}

.kimi-web-provider-meta-key.is-missing {
  color: var(--theme-text-warning, #fde68a);
}

.kimi-web-provider-models {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
  border-top: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
}

.kimi-web-provider-model {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 0;
  border-bottom: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
}

.kimi-web-provider-model:last-child {
  border-bottom: 0;
}

.kimi-web-provider-model-main {
  flex: 1 1 260px;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
}

.kimi-web-provider-model-name {
  font-size: var(--type-sm);
  font-weight: 700;
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
}

.kimi-web-provider-model-id,
.kimi-web-provider-model-context {
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #64748b));
  overflow-wrap: anywhere;
}

.kimi-web-provider-card-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.kimi-web-provider-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid
    var(
      --theme-action-button-border,
      var(--theme-modal-border, var(--theme-border-default, #334155))
    );
  border-radius: var(--radius-control);
  background: var(
    --theme-action-button-bg,
    var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.82)))
  );
  color: var(
    --theme-action-button-text,
    var(--theme-modal-text, var(--theme-text-primary, #e2e8f0))
  );
  font-size: var(--type-sm);
  font-family: inherit;
  min-height: 28px;
  padding: 4px 8px;
  cursor: pointer;
}

.kimi-web-provider-action:focus-visible,
.kimi-web-provider-model-details summary:focus-visible,
.kimi-web-provider-remove:focus-visible {
  outline: 2px solid var(--theme-focus-ring, var(--theme-modal-accent, #3b82f6));
  outline-offset: 2px;
}

.kimi-web-provider-action:hover:not(:disabled) {
  border-color: var(
    --theme-action-button-border,
    var(--theme-modal-accent, var(--theme-border-strong, #475569))
  );
  background: var(
    --theme-action-button-hover-bg,
    var(--theme-modal-active-bg, var(--theme-surface-panel-hover, rgba(30, 41, 59, 0.92)))
  );
}

.kimi-web-provider-action:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.kimi-web-provider-action.is-danger {
  color: var(--theme-text-danger, #fca5a5);
}

.kimi-web-provider-action.is-primary {
  border-color: var(
    --theme-action-button-accent-border,
    var(--theme-modal-accent, var(--theme-border-accent, rgba(96, 165, 250, 0.35)))
  );
  background: var(
    --theme-action-button-accent-bg,
    color-mix(
      in srgb,
      var(--theme-modal-accent, var(--theme-accent-primary, #3b82f6)) 18%,
      transparent
    )
  );
  color: var(
    --theme-action-button-accent-text,
    var(--theme-modal-active-text, var(--theme-text-primary, #dbeafe))
  );
}

.kimi-web-provider-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: 12px;
  border: 1px solid
    var(
      --theme-card-border,
      var(--theme-modal-border, var(--theme-border-default, rgba(51, 65, 85, 0.8)))
    );
  border-radius: 12px;
  background: var(
    --theme-card-bg,
    var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(2, 6, 23, 0.46)))
  );
}

.kimi-web-provider-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  font-size: var(--type-sm);
}

.kimi-web-provider-field input,
.kimi-web-provider-field select,
.kimi-web-provider-model-row input,
.kimi-web-provider-key-value {
  min-height: 38px;
  width: 100%;
  border: 1px solid
    var(--theme-search-border, var(--theme-modal-border, var(--theme-border-default, #334155)));
  border-radius: 9px;
  background: var(
    --theme-search-bg,
    var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.82)))
  );
  color: var(--theme-search-text, var(--theme-modal-text, var(--theme-text-primary, #e2e8f0)));
  font-size: var(--type-body);
  font-family: inherit;
  padding: 0 12px;
  outline: none;
}

.kimi-web-provider-field input:focus,
.kimi-web-provider-field select:focus,
.kimi-web-provider-model-row input:focus,
.kimi-web-provider-key-value:focus {
  border-color: var(--theme-modal-accent, var(--theme-border-accent, #60a5fa));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-modal-accent, #60a5fa) 24%, transparent);
}

.kimi-web-provider-field input:disabled {
  opacity: 0.6;
}

.kimi-web-provider-field small,
.kimi-web-provider-model-row small,
.kimi-web-provider-key small {
  min-height: 14px;
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.kimi-web-provider-field small.is-error,
.kimi-web-provider-model-row small.is-error,
.kimi-web-provider-model-row input.is-error {
  color: var(--theme-text-danger, #fecaca);
}

.kimi-web-provider-key {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: var(--radius-panel);
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  font-size: var(--type-sm);
}

.kimi-web-provider-key legend {
  padding: 0 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.kimi-web-provider-key-choice {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.kimi-web-provider-model-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.kimi-web-provider-row-header {
  font-size: var(--type-sm);
  font-weight: 700;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.kimi-web-provider-model-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 120px auto;
  align-items: center;
  gap: var(--space-2);
}

.kimi-web-provider-model-row small {
  grid-column: 1 / -1;
}

.kimi-web-provider-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 38px;
  border: none;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  cursor: pointer;
}

.kimi-web-provider-remove:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.kimi-web-provider-form-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}

@media (max-width: 760px) {
  .kimi-web-provider-card {
    grid-template-columns: minmax(0, 1fr);
  }

  .kimi-web-provider-card-actions {
    grid-column: 1;
    grid-row: auto;
  }

  .kimi-web-provider-model-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .kimi-web-provider-toolbar-actions {
    justify-content: stretch;
  }

  .kimi-web-provider-toolbar-actions > * {
    flex: 1 1 auto;
  }
}
</style>
