import type { BackendProviderResponse } from '../types/backend-domain';

type ModelChoice = { readonly id: string; readonly providerID?: string; readonly modelID: string };

export function formatProviderModelPath(providerID: string, modelID: string): string {
  if (!providerID) return modelID;
  if (!modelID) return providerID;
  if (modelID.startsWith(`${providerID}/`)) return modelID;
  const managedProvider = providerID.startsWith('managed:') ? providerID.slice('managed:'.length) : '';
  if (managedProvider && modelID.startsWith(`${managedProvider}/`)) return modelID;
  return `${providerID}/${modelID}`;
}

export function preferredProviderModel(models: readonly ModelChoice[], defaults: BackendProviderResponse['default']): string {
  for (const [providerID, modelID] of Object.entries(defaults ?? {})) {
    const match = models.find(model => model.providerID === providerID && model.modelID === modelID);
    if (match) return match.id;
  }
  return models[0]?.id ?? '';
}

export function restoredReasoningEffort(options: {
  readonly available: readonly (string | undefined)[];
  readonly current: string | undefined;
  readonly configured: string | undefined;
  readonly hasSavedSelection: boolean;
}): string | undefined {
  if (options.current !== undefined && options.available.includes(options.current)) return options.current;
  if (options.hasSavedSelection && options.available.includes(options.current)) return options.current;
  return options.available.includes(options.configured) ? options.configured : undefined;
}
