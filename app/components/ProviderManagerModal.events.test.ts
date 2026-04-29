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
    expect(modalSource).toContain('disabled_providers: disabledProviders');
    expect(providerConfigSource).toContain('provider?: Record<string, unknown>;');
    expect(i18nTypesSource).toContain('custom: {');
  });

  it('persists disconnects for config-backed providers', () => {
    const modalSource = readSource(resolve(__dirname, 'ProviderManagerModal.vue'));

    expect(modalSource).toContain("provider.source === 'config' || provider.source === 'custom'");
    expect(modalSource).toContain("provider.source !== 'env'");
    expect(modalSource).toContain('await deleteProviderAuth(providerId).catch(() => undefined);');
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
