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

export type ModelMeta = {
  displayName: string;
  providerLabel?: string;
};

export function resolveModelMetaForPath(
  modelPath: string | undefined,
  modelOptions: ReadonlyArray<ModelOption>,
): ModelMeta | undefined {
  if (!modelPath) return undefined;
  const matched = modelOptions.find((model) => model.id === modelPath);
  if (matched) {
    return {
      displayName: matched.displayName,
      providerLabel: matched.providerLabel,
    };
  }
  const lastSegment = modelPath.split('/').pop()?.trim();
  return {
    displayName: lastSegment || modelPath,
  };
}
