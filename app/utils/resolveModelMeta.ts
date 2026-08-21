export type ModelMeta = {
  displayName: string;
  providerLabel?: string;
};

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
  return new Map(
    modelOptions.map((model) => [
      model.id,
      {
        displayName: model.displayName,
        providerLabel: model.providerLabel,
      },
    ]),
  );
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
