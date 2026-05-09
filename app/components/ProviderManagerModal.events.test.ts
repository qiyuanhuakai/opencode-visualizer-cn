import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(path: string) {
  return readFileSync(path, 'utf8');
}

describe('ProviderManagerModal events', () => {
  it('uses matching model visibility and provider config events in App.vue', () => {
    const appSource = readSource(resolve(__dirname, '../App.vue'));
    const modalSource = readSource(resolve(__dirname, 'ProviderManagerModal.vue'));

    expect(modalSource).toContain("(event: 'update:model-visibility', value: ModelVisibilityEntry[]): void;");
    expect(modalSource).toContain("emit('update:model-visibility'");
    expect(appSource).toContain('@update:model-visibility="handleModelVisibilityUpdate"');

    expect(modalSource).toContain("(event: 'config-updated', value: ProviderConfigState): void;");
    expect(modalSource).toContain("emit('config-updated'");
    expect(appSource).toContain('@config-updated="handleProviderConfigUpdated"');

    expect(modalSource).toContain("(event: 'providers-changed'): void;");
    expect(modalSource).toContain("emit('providers-changed'");
    expect(appSource).toContain('@providers-changed="handleProvidersChanged"');
    expect(appSource).toContain('async function handleProvidersChanged()');
    expect(appSource).toContain('await fetchProviders(true);');
  });

  it('keeps provider connect buttons active when auth metadata is absent', () => {
    const modalSource = readSource(resolve(__dirname, 'ProviderManagerModal.vue'));

    expect(modalSource).toContain('const DEFAULT_API_AUTH_METHOD: ProviderAuthMethod');
    expect(modalSource).toContain('return methods && methods.length > 0 ? methods : [DEFAULT_API_AUTH_METHOD];');
    expect(modalSource).not.toContain('if (methods.length === 0) return null;');
  });

  it('matches OpenCode auth prompt conditions', () => {
    const modalSource = readSource(resolve(__dirname, 'ProviderManagerModal.vue'));

    expect(modalSource).toContain("op: 'eq' | 'neq';");
    expect(modalSource).toContain("return prompt.when.op === 'eq' ? actual === prompt.when.value : actual !== prompt.when.value;");
  });

  it('adds an OpenCode-compatible custom provider flow', () => {
    const modalSource = readSource(resolve(__dirname, 'ProviderManagerModal.vue'));
    const providerConfigSource = readSource(resolve(__dirname, '../utils/providerConfig.ts'));
    const i18nTypesSource = readSource(resolve(__dirname, '../i18n/types.ts'));

    expect(modalSource).toContain('showCustomProviderForm');
    expect(modalSource).toContain('CUSTOM_PROVIDER_NPM = \'@ai-sdk/openai-compatible\'');
    expect(modalSource).toContain('provider: {');
    expect(modalSource).toContain('[result.providerID]: result.config');
    expect(modalSource).toContain("await setProviderAuth(result.providerID, { type: 'api', key: result.key });");
    expect(modalSource).toContain('const providerEnablePatch = buildProviderDisabledPatch(props.providerConfig, result.providerID, true);');
    expect(providerConfigSource).toContain('provider?: Record<string, unknown>;');
    expect(i18nTypesSource).toContain('custom: {');
  });

  it('supports Codex custom providers through config.toml model_providers', () => {
    const modalSource = readSource(resolve(__dirname, 'ProviderManagerModal.vue'));
    const backendTypesSource = readSource(resolve(__dirname, '../backends/types.ts'));
    const codexAdapterSource = readSource(resolve(__dirname, '../backends/codex/codexAdapter.ts'));

    expect(modalSource).toContain("active.kind === 'codex'");
    expect(modalSource).toContain('type CodexCustomProviderConfig');
    expect(modalSource).toContain("wire_api: 'responses'");
    expect(modalSource).toContain('models?: Record<string, { name: string }>;');
    expect(modalSource).toContain('models: modelMetadata');
    expect(modalSource).toContain('[`model_providers.${result.providerID}`]: codexConfig');
    expect(modalSource).toContain('[`vis.model_providers.${result.providerID}`]: { models: modelMetadata }');
    expect(modalSource).toContain('...providerEnablePatch');
    expect(modalSource).toContain('buildProviderDisabledPatch(props.providerConfig, result.providerID, true)');
    expect(modalSource).not.toContain('model_provider: result.providerID');
    expect(backendTypesSource).toContain('batchWriteConfig?');
    expect(codexAdapterSource).toContain("this.client.request<CodexConfigBatchWriteResult>('config/batchWrite'");
    expect(codexAdapterSource).toContain('async updateGlobalConfig(payload: Record<string, unknown>)');
  });

  it('persists disconnects for config-backed providers', () => {
    const modalSource = readSource(resolve(__dirname, 'ProviderManagerModal.vue'));

    expect(modalSource).toContain("provider.source === 'config' || provider.source === 'custom'");
    expect(modalSource).toContain("provider.source !== 'env'");
    expect(modalSource).toContain('if (deleteProviderAuth) await deleteProviderAuth(providerId).catch(() => undefined);');
    expect(modalSource).toContain('buildProviderDisabledPatch(props.providerConfig, providerId, false)');
    expect(modalSource).toContain("@click=\"disconnectProvider(provider)\"");
  });

  it('does not switch models by clicking provider cards', () => {
    const appSource = readSource(resolve(__dirname, '../App.vue'));
    const modalSource = readSource(resolve(__dirname, 'ProviderManagerModal.vue'));

    expect(modalSource).not.toContain("(event: 'select-model'");
    expect(modalSource).not.toContain("emit('select-model'");
    expect(modalSource).not.toContain('selectProvider(');
    expect(appSource).not.toContain('@select-model="handleSelectedModelUpdate"');
  });

  it('keeps slash-containing model ids intact when toggling visibility', () => {
    const modalSource = readSource(resolve(__dirname, 'ProviderManagerModal.vue'));

    expect(modalSource).toContain('function parseModelKey(modelKey: string)');
    expect(modalSource).toContain("const slashIndex = normalized.indexOf('/');");
    expect(modalSource).toContain('const modelID = normalized.slice(slashIndex + 1).trim();');
    expect(modalSource).toContain('const { providerID, modelID } = parseModelKey(modelKey);');
    expect(modalSource).not.toContain('const [providerID, modelID] = modelKey.split');
  });

  it('refreshes Codex providers when opening provider manager', () => {
    const appSource = readSource(resolve(__dirname, '../App.vue'));

    expect(appSource).toContain('watch(isProviderManagerOpen, (open) => {');
    expect(appSource).toContain("if (!open || activeBackendKind.value !== 'codex') return;");
    expect(appSource).toContain('void Promise.all([fetchGlobalProviderConfig(), fetchProviders(true)]);');
  });

  it('resets Codex selection and force-refreshes OpenCode providers when switching back to OpenCode', () => {
    const appSource = readSource(resolve(__dirname, '../App.vue'));
    const activationSource = readSource(resolve(__dirname, '../composables/useBackendActivation.ts'));

    expect(appSource).toContain("import { useBackendActivation } from './composables/useBackendActivation';");
    expect(appSource).toContain('const {');
    expect(appSource).toContain('} = useBackendActivation({');
    expect(appSource).toContain('async function hydrateActiveWorktreeResources() {');
    expect(activationSource).toContain("options.activeBackendKind.value = 'opencode';");
    expect(activationSource).toContain("options.setActiveBackendKind('opencode');");
    expect(activationSource).toContain('options.serverState.bootstrapped.value = false;');
    expect(activationSource).toContain('Object.keys(options.serverState.projects).forEach((key) => {');
    expect(activationSource).toContain("options.selectedProjectId.value = '';");
    expect(activationSource).toContain("options.selectedSessionId.value = '';");
    expect(activationSource).toContain('options.providerConfig.value = null;');
    expect(activationSource).toContain('options.providersLoaded.value = false;');
    expect(activationSource).toContain('options.providers.value = [];');
    expect(activationSource).toContain('options.connectedProviderIds.value = [];');
    expect(activationSource).toContain('options.modelOptions.value = [];');
    expect(activationSource).toContain("options.selectedModel.value = '';");
    expect(activationSource).toContain('await options.bootstrapSelections();');
    expect(activationSource).toContain('await options.hydrateActiveWorktreeResources();');
    expect(activationSource).toContain('await options.fetchGlobalProviderConfig();');
    expect(activationSource).toContain('await Promise.all([options.fetchProviders(true), options.fetchAgents()]);');
  });

  it('only restores initial OpenCode query selection when that session exists in state', () => {
    const appSource = readSource(resolve(__dirname, '../App.vue'));

    expect(appSource).toContain('function sessionExistsInProjects(projectId: string, sessionId: string)');
    expect(appSource).toContain('sessionExistsInProjects(initialProjectId, initialSessionId)');
    expect(appSource).toContain('await initializeSessionSelection();');
  });

  it('syncs Codex active provider and model before sending custom models', () => {
    const appSource = readSource(resolve(__dirname, '../App.vue'));

    expect(appSource).toContain('async function syncCodexActiveProviderModel(providerID: string, modelID: string)');
    expect(appSource).toContain("const CODEX_OFFICIAL_MODEL_PROVIDER = 'openai';");
    expect(appSource).toContain('function codexAppServerProviderId(providerID: string)');
    expect(appSource).toContain('function shouldStartNewCodexThreadForProvider(sessionId: string, providerID: string)');
    expect(appSource).toContain('const codexProvider = codexAppServerProviderId(normalizedProvider);');
    expect(appSource).toContain('?.modelProvider');
    expect(appSource).toContain("? CODEX_OFFICIAL_MODEL_PROVIDER");
    expect(appSource).toContain("edits.push({ keyPath: 'model_provider', value: codexProvider, mergeStrategy: 'replace' });");
    expect(appSource).toContain("edits.push({ keyPath: 'model', value: normalizedModel, mergeStrategy: 'replace' });");
    expect(appSource).not.toContain('configStringValue(');
    expect(appSource).not.toContain("mergeStrategy: 'remove'");
    expect(appSource).toContain('const startNewCodexThread = selectedCodexProvider');
    expect(appSource).toContain('forceNewThread: startNewCodexThread');
    expect(appSource).toContain('await syncCodexActiveProviderModel(selectedCodexProvider, selectedCodexModel);');
    expect(appSource).toContain('if (selectedCodexModelKey) codexApi.selectModel(selectedCodexModelKey);');
    expect(appSource).not.toContain('codexApi.selectModel(selectedCodexModel);');
  });

  it('renders all providers as compact two-column rows instead of card grid items', () => {
    const modalSource = readSource(resolve(__dirname, 'ProviderManagerModal.vue'));

    expect(modalSource).toContain('class="provider-view-all-list"');
    expect(modalSource).toContain('class="provider-mini-row"');
    expect(modalSource).toContain('class="provider-mini-row-title"');
    expect(modalSource).toContain('class="provider-mini-row-status"');
    expect(modalSource).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(modalSource).toContain('min-height: 42px;');
    expect(modalSource).toContain('line-height: 1.02;');
    expect(modalSource).not.toContain('class="provider-view-all-grid"');
    expect(modalSource).not.toContain('class="provider-mini-card"');
  });

  it('keeps connected provider rows compact', () => {
    const modalSource = readSource(resolve(__dirname, 'ProviderManagerModal.vue'));

    expect(modalSource).toContain('min-height: 54px;');
    expect(modalSource).toContain('padding: 8px 10px;');
    expect(modalSource).toContain('flex: 0 0 178px;');
    expect(modalSource).toContain('white-space: nowrap;');
  });
});
