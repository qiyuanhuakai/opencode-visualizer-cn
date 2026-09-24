export type ModelMeta = {
  displayName: string;
  providerLabel?: string;
};

import { formatProviderModelPath } from './providerSelection';

export type ModelOption = {
  id: string;
  modelID: string;
  label: string;
  displayName: string;
  providerID?: string;
  providerLabel?: string;
  variants?: Record<string, unknown>;
  attachmentCapable?: boolean;
};

export function buildModelMetaIndex(
  modelOptions: ReadonlyArray<ModelOption>,
): ReadonlyMap<string, ModelMeta> {
  const index = new Map<string, ModelMeta>();
  for (const model of modelOptions) {
    const meta = { displayName: model.displayName, providerLabel: model.providerLabel };
    index.set(model.id, meta);
    if (model.providerID) {
      const displayPath = formatProviderModelPath(model.providerID, model.modelID);
      if (!index.has(displayPath)) index.set(displayPath, meta);
    }
  }
  return index;
}

export function resolveModelMetaForPath(
  modelPath: string | undefined,
  modelMetaByPath: ReadonlyMap<string, ModelMeta>,
): ModelMeta | undefined {
  if (!modelPath) return undefined;
  const matched = modelMetaByPath.get(modelPath);
  if (matched) return matched;
  const lastSegment = modelPath.split('/').pop()?.trim();
  return {
    displayName: lastSegment || modelPath,
  };
}
