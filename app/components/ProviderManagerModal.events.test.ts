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
