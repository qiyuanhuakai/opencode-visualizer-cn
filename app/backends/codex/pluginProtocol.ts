import type { CodexPlugin, CodexPluginListResult, CodexPluginSource } from './codexAdapter';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizePluginSource(value: unknown): CodexPluginSource | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === 'local' && typeof value.path === 'string') {
    return { type: 'local', path: value.path };
  }
  if (
    value.type === 'git' &&
    typeof value.url === 'string' &&
    typeof value.path === 'string' &&
    typeof value.refName === 'string' &&
    typeof value.sha === 'string'
  ) {
    return {
      type: 'git',
      url: value.url,
      path: value.path,
      refName: value.refName,
      sha: value.sha,
    };
  }
  if (
    value.type === 'npm' &&
    typeof value.package === 'string' &&
    typeof value.version === 'string' &&
    typeof value.registry === 'string'
  ) {
    return {
      type: 'npm',
      package: value.package,
      version: value.version,
      registry: value.registry,
    };
  }
  return value.type === 'remote' ? { type: 'remote' } : null;
}

function normalizePlugin(value: unknown): CodexPlugin | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') {
    return null;
  }
  const pluginInterface = isRecord(value.interface) ? value.interface : {};
  const installed = value.installed === true;
  const enabled = value.enabled === true;
  const available = value.availability !== 'DISABLED_BY_ADMIN';
  const description =
    optionalString(value.description) ?? optionalString(pluginInterface.shortDescription);
  const logoUrl = optionalString(value.logoUrl) ?? optionalString(pluginInterface.logoUrl);
  const logoUrlDark =
    optionalString(value.logoUrlDark) ?? optionalString(pluginInterface.logoUrlDark);
  const state = optionalString(value.state) ?? (installed ? 'installed' : undefined);

  return {
    id: value.id,
    name: value.name,
    ...(description ? { description } : {}),
    ...(logoUrl ? { logoUrl } : {}),
    ...(logoUrlDark ? { logoUrlDark } : {}),
    ...(typeof value.distributionChannel === 'string'
      ? { distributionChannel: value.distributionChannel }
      : {}),
    branding: value.branding ?? pluginInterface,
    appMetadata: value.appMetadata ?? pluginInterface,
    labels: value.labels ?? value.keywords,
    ...(typeof value.installUrl === 'string' ? { installUrl: value.installUrl } : {}),
    isAccessible:
      available &&
      (typeof value.isAccessible === 'boolean' ? value.isAccessible : installed || enabled),
    isEnabled: available && (typeof value.isEnabled === 'boolean' ? value.isEnabled : enabled),
    source: normalizePluginSource(value.source),
    ...(state ? { state } : {}),
  };
}

export function normalizeCodexPluginListResult(value: unknown): CodexPluginListResult {
  if (!isRecord(value) || !Array.isArray(value.marketplaces)) {
    throw new Error('Codex plugin/list returned an invalid response.');
  }
  const marketplaces = value.marketplaces.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !Array.isArray(entry.plugins)) {
      return [];
    }
    const plugins = entry.plugins.flatMap((plugin) => {
      const normalized = normalizePlugin(plugin);
      return normalized ? [normalized] : [];
    });
    return [
      {
        name: entry.name,
        ...(typeof entry.path === 'string' || entry.path === null ? { path: entry.path } : {}),
        plugins,
      },
    ];
  });
  const errors = Array.isArray(value.marketplaceLoadErrors)
    ? value.marketplaceLoadErrors
    : value.errors;
  const featured = Array.isArray(value.featuredPluginIds)
    ? value.featuredPluginIds
    : value.featured;
  return {
    marketplaces,
    ...(Array.isArray(errors) ? { errors } : {}),
    ...(Array.isArray(featured)
      ? { featured: featured.filter((entry): entry is string => typeof entry === 'string') }
      : {}),
  };
}
