import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useProviderModelSync } from './useProviderModelSync';

function createFixture() {
  const providerConfig = ref<Record<string, unknown> | null>({ source: 'fallback' });
  const config = ref<{ config: Record<string, unknown> } | null>(null);
  const threads = ref<Array<{ id: string; modelProvider?: string | null }>>([]);
  const batchWriteConfig = vi.fn(async () => undefined);
  const sync = useProviderModelSync({
    codexProjectId: 'codex',
    officialProviderId: 'openai',
    providerConfig,
    config,
    threads,
    batchWriteConfig,
  });
  return { providerConfig, config, threads, batchWriteConfig, ...sync };
}

describe('useProviderModelSync', () => {
  it('Given an official model containing slashes, When synchronization runs, Then the exact provider and model edits are written before returning refreshed config', async () => {
    const fixture = createFixture();
    fixture.batchWriteConfig.mockImplementation(async () => {
      fixture.config.value = { config: { source: 'refreshed' } };
    });

    await expect(
      fixture.syncCodexActiveProviderModel(' codex ', ' org/model/version '),
    ).resolves.toEqual({ source: 'refreshed' });
    expect(fixture.batchWriteConfig).toHaveBeenCalledExactlyOnceWith([
      { keyPath: 'model_provider', value: 'openai', mergeStrategy: 'replace' },
      { keyPath: 'model', value: 'org/model/version', mergeStrategy: 'replace' },
    ]);
  });

  it('Given an empty provider or model, When synchronization is requested, Then config is not changed', async () => {
    const fixture = createFixture();

    await expect(fixture.syncCodexActiveProviderModel('', 'model')).resolves.toEqual({
      source: 'fallback',
    });
    await expect(fixture.syncCodexActiveProviderModel('provider', '  ')).resolves.toEqual({
      source: 'fallback',
    });
    expect(fixture.batchWriteConfig).not.toHaveBeenCalled();
  });

  it('Given an existing thread on another provider, When a custom provider is selected, Then only that thread requires a fresh start', () => {
    const fixture = createFixture();
    fixture.threads.value = [
      { id: 'same', modelProvider: 'custom' },
      { id: 'different', modelProvider: 'openai' },
      { id: 'unknown' },
    ];

    expect(fixture.shouldStartNewCodexThreadForProvider('same', 'custom')).toBe(false);
    expect(fixture.shouldStartNewCodexThreadForProvider('different', 'custom')).toBe(true);
    expect(fixture.shouldStartNewCodexThreadForProvider('unknown', 'custom')).toBe(false);
    expect(fixture.shouldStartNewCodexThreadForProvider('', 'custom')).toBe(false);
  });
});
