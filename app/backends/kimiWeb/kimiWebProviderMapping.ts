import type { BackendProviderInfo, BackendProviderModel } from '../../types/backend-domain';
import type { KimiWebProviderWire } from '../../utils/kimiWeb';

function modelIdForProvider(providerId: string, qualifiedModelId: string): string {
  const prefix = `${providerId}/`;
  return qualifiedModelId.startsWith(prefix)
    ? qualifiedModelId.slice(prefix.length)
    : qualifiedModelId;
}

function mapProviderModel(providerId: string, qualifiedModelId: string): BackendProviderModel {
  const modelId = modelIdForProvider(providerId, qualifiedModelId);
  return {
    id: modelId,
    name: modelId,
    providerID: providerId,
    capabilities: { attachment: false, reasoning: false, toolcall: true },
  };
}

export function mapKimiWebProvidersToProviderInfo(
  providers: readonly KimiWebProviderWire[],
): BackendProviderInfo[] {
  return providers.map((provider) => ({
    id: provider.id,
    name: provider.id,
    models: Object.fromEntries(
      provider.models.map((qualifiedModelId) => {
        const model = mapProviderModel(provider.id, qualifiedModelId);
        return [model.id, model];
      }),
    ),
  }));
}
