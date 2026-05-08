export type ProviderConfigState = {
  enabled_providers?: string[];
  disabled_providers?: string[];
  provider?: Record<string, unknown>;
  model_providers?: Record<string, unknown>;
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
  const currentEnabled = normalizeProviderIds(providerConfig?.enabled_providers);
  const currentDisabled = new Set(normalizeProviderIds(providerConfig?.disabled_providers));
  if (normalizedProviderId) {
    if (nextEnabled) {
      currentDisabled.delete(normalizedProviderId);
    } else {
      currentDisabled.add(normalizedProviderId);
    }
  }
  const patch: Pick<ProviderConfigState, 'enabled_providers' | 'disabled_providers'> = {
    disabled_providers: Array.from(currentDisabled),
  };
  if (nextEnabled && normalizedProviderId && currentEnabled.length > 0 && !currentEnabled.includes(normalizedProviderId)) {
    patch.enabled_providers = [...currentEnabled, normalizedProviderId];
  }
  return patch;
}
