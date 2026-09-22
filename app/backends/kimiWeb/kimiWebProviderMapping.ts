import type { KimiWebModelObjectWire, KimiWebProviderWire } from '../../utils/kimiWeb';

export type KimiWebManagedProviderSource = KimiWebProviderWire & {
  readonly name?: string;
  readonly modelDetails: readonly KimiWebModelObjectWire[];
};

export type KimiWebManagedProviderModel = {
  readonly id: string;
  readonly name: string;
  readonly providerID: string;
  readonly maxContextSize?: number;
  readonly capabilities: {
    readonly attachment: boolean;
    readonly reasoning: boolean;
    readonly toolcall: boolean;
  };
};

export type KimiWebManagedProvider = {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  readonly hasApiKey: boolean;
  readonly status: string;
  readonly defaultModel?: string;
  readonly models: readonly KimiWebManagedProviderModel[];
};

function modelIdForProvider(providerId: string, qualifiedModelId: string): string {
  const prefix = `${providerId}/`;
  return qualifiedModelId.startsWith(prefix)
    ? qualifiedModelId.slice(prefix.length)
    : qualifiedModelId;
}

function mapCapabilities(capabilities: readonly string[] = []) {
  return {
    attachment: capabilities.includes('vision'),
    reasoning: capabilities.includes('thinking') || capabilities.includes('reasoning'),
    toolcall: capabilities.includes('tool_use') || capabilities.includes('tools'),
  };
}

function mapProviderModel(
  provider: KimiWebManagedProviderSource,
  qualifiedModelId: string,
): KimiWebManagedProviderModel {
  const modelId = modelIdForProvider(provider.id, qualifiedModelId);
  const details = provider.modelDetails.find(
    (model) => model.model === modelId || model.model === qualifiedModelId,
  );
  return {
    id: modelId,
    name: details?.name || modelId,
    providerID: provider.id,
    maxContextSize: details?.max_context_size,
    capabilities: mapCapabilities(details?.capabilities),
  };
}

export function mapKimiWebProvidersToProviderInfo(
  providers: readonly KimiWebManagedProviderSource[],
): KimiWebManagedProvider[] {
  return providers.map((provider) => ({
    id: provider.id,
    name: provider.name || provider.id,
    baseUrl: provider.base_url,
    hasApiKey: provider.has_api_key,
    status: provider.status,
    defaultModel: provider.default_model,
    models: provider.models.map((modelId) => mapProviderModel(provider, modelId)),
  }));
}
