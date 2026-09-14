import type { Ref } from 'vue';
import type { ConfigMergeStrategy } from '../backends/types';

type ProviderConfigState = Record<string, unknown>;

type ProviderModelSyncOptions = {
  readonly codexProjectId: string;
  readonly officialProviderId: string;
  readonly providerConfig: Ref<ProviderConfigState | null>;
  readonly config: Ref<{ readonly config: ProviderConfigState } | null>;
  readonly threads: Ref<
    ReadonlyArray<{ readonly id: string; readonly modelProvider?: string | null }>
  >;
  readonly batchWriteConfig: (
    edits: Array<{
      keyPath: string;
      value: unknown;
      mergeStrategy: ConfigMergeStrategy;
    }>,
  ) => Promise<void>;
};

export function useProviderModelSync(options: ProviderModelSyncOptions) {
  function appServerProviderId(providerId: string) {
    const normalizedProvider = providerId.trim();
    return normalizedProvider === options.codexProjectId
      ? options.officialProviderId
      : normalizedProvider;
  }

  async function syncCodexActiveProviderModel(
    providerId: string,
    modelId: string,
  ): Promise<ProviderConfigState | null> {
    const normalizedProvider = providerId.trim();
    const normalizedModel = modelId.trim();
    if (!normalizedProvider || !normalizedModel) return options.providerConfig.value;

    await options.batchWriteConfig([
      {
        keyPath: 'model_provider',
        value: appServerProviderId(normalizedProvider),
        mergeStrategy: 'replace',
      },
      { keyPath: 'model', value: normalizedModel, mergeStrategy: 'replace' },
    ]);
    return options.config.value?.config ?? options.providerConfig.value;
  }

  function shouldStartNewCodexThreadForProvider(sessionId: string, providerId: string) {
    const desiredProvider = appServerProviderId(providerId);
    if (!sessionId || !desiredProvider) return false;
    const currentProvider = options.threads.value
      .find((thread) => thread.id === sessionId)
      ?.modelProvider?.trim();
    return Boolean(currentProvider && currentProvider !== desiredProvider);
  }

  return { syncCodexActiveProviderModel, shouldStartNewCodexThreadForProvider };
}
