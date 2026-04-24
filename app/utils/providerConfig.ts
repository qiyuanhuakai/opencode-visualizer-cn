export type ProviderConfigState = {
  enabled_providers?: string[];
  disabled_providers?: string[];
};

export function normalizeProviderIds(values?: string[]) {
  return Array.isArray(values)
    ? values.map((value) => value.trim()).filter((value) => value.length > 0)
    : [];
}

export function buildProviderDisabledPatch(
  providerConfig: ProviderConfigState | null | undefined,
  providerId: string,
  nextEnabled: boolean,
) {
  const normalizedProviderId = providerId.trim();
  const currentDisabled = new Set(normalizeProviderIds(providerConfig?.disabled_providers));
  if (normalizedProviderId) {
    if (nextEnabled) {
      currentDisabled.delete(normalizedProviderId);
    } else {
      currentDisabled.add(normalizedProviderId);
    }
  }
  return {
    disabled_providers: Array.from(currentDisabled),
  };
}
