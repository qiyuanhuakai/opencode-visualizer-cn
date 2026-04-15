import {
  DEFAULT_REGION_THEME,
  FOREST_PRESET,
  OCEAN_PRESET,
  REGION_COLOR_FIELDS,
  REGION_NAMES,
  SAKURA_PRESET,
  THEME_COMPONENT_FIELDS,
  type ThemeComponentConfig,
  type ThemeComponentName,
  type RegionColors,
  type RegionName,
  type RegionThemeConfig,
} from './regionTheme';
import { StorageKeys, storageGetJSON, storageRemove, storageSetJSON } from './storageKeys';

export type ThemeRegistrySource = 'builtin' | 'external';

export type ThemeRegistryEntry = {
  id: string;
  source: ThemeRegistrySource;
  theme: RegionThemeConfig;
  removable: boolean;
  labelKey?: string;
  badge?: string;
  badgeKey?: string;
  description?: string;
  descriptionKey?: string;
  swatches: string[];
};

export type ExternalThemeDefinition = {
  $schema?: string;
  id: string;
  label: string;
  badge?: string;
  description?: string;
  swatches?: string[];
  regions: Record<RegionName, Partial<RegionColors>>;
  components?: ThemeComponentConfig;
};

type StoredExternalThemeRegistry = {
  version: 1;
  themes: ExternalThemeDefinition[];
};

export const THEME_SCHEMA_URL = '/schema/theme.schema.json';

const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/i;

function firstDefined(...values: Array<string | undefined>) {
  return values.find((value) => typeof value === 'string' && value.length > 0);
}

function normalizeColorValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeThemeRegistryId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !THEME_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function normalizeThemeLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cloneRegionMap(regions: Record<RegionName, Partial<RegionColors>>): Record<RegionName, Partial<RegionColors>> {
  return Object.fromEntries(
    REGION_NAMES.map((regionName) => {
      const region = regions[regionName] ?? {};
      const nextRegion = Object.fromEntries(
        REGION_COLOR_FIELDS.flatMap((field) => {
          const value = normalizeColorValue(region[field]);
          if (!value) return [];
          return [[field, value]];
        }),
      ) as Partial<RegionColors>;
      return [regionName, nextRegion];
    }),
  ) as Record<RegionName, Partial<RegionColors>>;
}

function normalizeThemeRegions(input: unknown): Record<RegionName, Partial<RegionColors>> | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;

  return Object.fromEntries(
    REGION_NAMES.map((regionName) => {
      const regionValue = record[regionName];
      if (!regionValue || typeof regionValue !== 'object') {
        return [regionName, {}];
      }

      const regionRecord = regionValue as Record<string, unknown>;
      const region = Object.fromEntries(
        REGION_COLOR_FIELDS.flatMap((field) => {
          const value = normalizeColorValue(regionRecord[field]);
          if (!value) return [];
          return [[field, value]];
        }),
      ) as Partial<RegionColors>;

      return [regionName, region];
    }),
  ) as Record<RegionName, Partial<RegionColors>>;
}

function cloneThemeComponents(components: ThemeComponentConfig | undefined): ThemeComponentConfig | undefined {
  if (!components) return undefined;
  return {
    dropdown: components.dropdown ? { ...components.dropdown } : undefined,
    chip: components.chip ? { ...components.chip } : undefined,
    iconAction: components.iconAction ? { ...components.iconAction } : undefined,
    dock: components.dock ? { ...components.dock } : undefined,
    formControl: components.formControl ? { ...components.formControl } : undefined,
    tab: components.tab ? { ...components.tab } : undefined,
    badge: components.badge ? { ...components.badge } : undefined,
    card: components.card ? { ...components.card } : undefined,
    toggle: components.toggle ? { ...components.toggle } : undefined,
    listRow: components.listRow ? { ...components.listRow } : undefined,
    emptyState: components.emptyState ? { ...components.emptyState } : undefined,
    actionButton: components.actionButton ? { ...components.actionButton } : undefined,
    search: components.search ? { ...components.search } : undefined,
  };
}

function normalizeThemeComponents(input: unknown): ThemeComponentConfig | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  return Object.fromEntries(
    (Object.keys(THEME_COMPONENT_FIELDS) as ThemeComponentName[]).map((componentName) => {
      const componentValue = record[componentName];
      const componentRecord =
        componentValue && typeof componentValue === 'object' && !Array.isArray(componentValue)
          ? (componentValue as Record<string, unknown>)
          : {};
      const fields = THEME_COMPONENT_FIELDS[componentName] as readonly string[];
      const component = Object.fromEntries(
        fields.flatMap((field) => {
          const value = normalizeColorValue(componentRecord[field]);
          if (!value) return [];
          return [[field, value]];
        }),
      );
      return [componentName, component];
    }),
  ) as ThemeComponentConfig;
}

function deriveThemeSwatches(theme: RegionThemeConfig): string[] {
  const page = theme.regions.pageBackground ?? {};
  const top = theme.regions.topPanel ?? {};
  const output = theme.regions.outputPanel ?? {};
  const modal = theme.regions.modalPanel ?? {};

  return [
    firstDefined(page.bg, top.bg, '#07111f') ?? '#07111f',
    firstDefined(top.bg, output.bg, '#0f172a') ?? '#0f172a',
    firstDefined(output.accent, top.accent, modal.accent, '#60a5fa') ?? '#60a5fa',
    firstDefined(output.text, page.text, '#e2e8f0') ?? '#e2e8f0',
  ];
}

function normalizeSwatches(value: unknown, theme: RegionThemeConfig): string[] {
  if (!Array.isArray(value)) {
    return deriveThemeSwatches(theme);
  }

  const swatches = value
    .map((item) => normalizeColorValue(item))
    .filter((item): item is string => Boolean(item))
    .slice(0, 4);

  return swatches.length > 0 ? swatches : deriveThemeSwatches(theme);
}

const BUILTIN_THEME_ENTRIES: ThemeRegistryEntry[] = [
  {
    id: DEFAULT_REGION_THEME.name,
    source: 'builtin',
    theme: DEFAULT_REGION_THEME,
    removable: false,
    labelKey: 'settings.theme.presetNames.default',
    badgeKey: 'settings.theme.presetBadges.balanced',
    descriptionKey: 'settings.theme.presetDescriptions.default',
    swatches: deriveThemeSwatches(DEFAULT_REGION_THEME),
  },
  {
    id: OCEAN_PRESET.name,
    source: 'builtin',
    theme: OCEAN_PRESET,
    removable: false,
    labelKey: 'settings.theme.presetNames.ocean',
    badgeKey: 'settings.theme.presetBadges.cool',
    descriptionKey: 'settings.theme.presetDescriptions.ocean',
    swatches: deriveThemeSwatches(OCEAN_PRESET),
  },
  {
    id: FOREST_PRESET.name,
    source: 'builtin',
    theme: FOREST_PRESET,
    removable: false,
    labelKey: 'settings.theme.presetNames.forest',
    badgeKey: 'settings.theme.presetBadges.natural',
    descriptionKey: 'settings.theme.presetDescriptions.forest',
    swatches: deriveThemeSwatches(FOREST_PRESET),
  },
  {
    id: SAKURA_PRESET.name,
    source: 'builtin',
    theme: SAKURA_PRESET,
    removable: false,
    badgeKey: 'settings.theme.presetBadges.expressive',
    descriptionKey: 'settings.theme.presetDescriptions.sakura',
    swatches: deriveThemeSwatches(SAKURA_PRESET),
  },
];

export function listBuiltinThemeRegistryEntries(): ThemeRegistryEntry[] {
  return BUILTIN_THEME_ENTRIES.map((entry) => ({
    ...entry,
    theme: {
      name: entry.theme.name,
      label: entry.theme.label,
      regions: cloneRegionMap(entry.theme.regions),
    },
    swatches: [...entry.swatches],
  }));
}

function normalizeExternalThemeDefinition(input: unknown): ExternalThemeDefinition | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const id = normalizeThemeRegistryId(record.id);
  const label = normalizeThemeLabel(record.label);
  const regions = normalizeThemeRegions(record.regions);
  const components = normalizeThemeComponents(record.components);

  if (!id || !label || !regions) {
    return null;
  }

  const theme: RegionThemeConfig = {
    name: id,
    label,
    regions,
    components,
  };

  return {
    id,
    label,
    badge: normalizeThemeLabel(record.badge) ?? undefined,
    description: normalizeThemeLabel(record.description) ?? undefined,
    swatches: normalizeSwatches(record.swatches, theme),
    regions: cloneRegionMap(regions),
    components: cloneThemeComponents(components),
  };
}

function isStoredExternalThemeRegistry(value: unknown): value is StoredExternalThemeRegistry {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && Array.isArray(record.themes);
}

export function normalizeStoredExternalThemes(input: unknown): ExternalThemeDefinition[] {
  if (!isStoredExternalThemeRegistry(input)) return [];
  const normalized = input.themes
    .map((theme) => normalizeExternalThemeDefinition(theme))
    .filter((theme): theme is ExternalThemeDefinition => Boolean(theme))
    .filter((theme) => !BUILTIN_THEME_ENTRIES.some((entry) => entry.id === theme.id));

  const seen = new Set<string>();
  return normalized.filter((theme) => {
    if (seen.has(theme.id)) return false;
    seen.add(theme.id);
    return true;
  });
}

export function readStoredExternalThemes(): ExternalThemeDefinition[] {
  return normalizeStoredExternalThemes(storageGetJSON(StorageKeys.settings.themeRegistry));
}

export function writeStoredExternalThemes(themes: ExternalThemeDefinition[]): void {
  if (themes.length === 0) {
    storageRemove(StorageKeys.settings.themeRegistry);
    return;
  }

  storageSetJSON(StorageKeys.settings.themeRegistry, {
    version: 1,
    themes,
  } satisfies StoredExternalThemeRegistry);
}

export function parseExternalThemeFile(input: unknown): ExternalThemeDefinition {
  const theme = normalizeExternalThemeDefinition(input);

  if (!theme) {
    throw new Error('Theme file does not contain any valid themes.');
  }

  if (BUILTIN_THEME_ENTRIES.some((entry) => entry.id === theme.id)) {
    throw new Error(`Theme id "${theme.id}" conflicts with a built-in theme.`);
  }

  return theme;
}

export function parseExternalThemeFileText(text: string): ExternalThemeDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Theme file must be valid JSON.');
  }

  return parseExternalThemeFile(parsed);
}

export function upsertExternalThemes(
  existing: ExternalThemeDefinition[],
  incoming: ExternalThemeDefinition[],
): ExternalThemeDefinition[] {
  const next = new Map(existing.map((theme) => [theme.id, theme]));
  for (const theme of incoming) {
    next.set(theme.id, theme);
  }
  return Array.from(next.values());
}

export function removeStoredExternalTheme(themes: ExternalThemeDefinition[], id: string): ExternalThemeDefinition[] {
  return themes.filter((theme) => theme.id !== id);
}

export function createExternalThemeRegistryEntry(theme: ExternalThemeDefinition): ThemeRegistryEntry {
  return {
    id: theme.id,
    source: 'external',
    removable: true,
    badge: theme.badge,
    description: theme.description,
    swatches: normalizeSwatches(theme.swatches, {
      name: theme.id,
      label: theme.label,
      regions: theme.regions,
      components: theme.components,
    }),
    theme: {
      name: theme.id,
      label: theme.label,
      regions: cloneRegionMap(theme.regions),
      components: cloneThemeComponents(theme.components),
    },
  };
}

export function createExternalThemeDefinition(theme: RegionThemeConfig, meta?: Pick<ExternalThemeDefinition, 'badge' | 'description' | 'swatches'>): ExternalThemeDefinition {
  return {
    $schema: THEME_SCHEMA_URL,
    id: theme.name,
    label: theme.label,
    badge: meta?.badge,
    description: meta?.description,
    swatches: meta?.swatches ? [...meta.swatches] : deriveThemeSwatches(theme),
    regions: cloneRegionMap(theme.regions),
    components: cloneThemeComponents(theme.components),
  };
}

export function createThemeTemplate(themeId = 'my-theme', label = 'My Theme'): ExternalThemeDefinition & { $schema: string } {
  return {
    $schema: THEME_SCHEMA_URL,
    ...createExternalThemeDefinition(
      {
        name: themeId,
        label,
        regions: Object.fromEntries(REGION_NAMES.map((regionName) => [regionName, {}])) as Record<RegionName, Partial<RegionColors>>,
        components: {
          dropdown: {},
          chip: {},
          iconAction: {},
          dock: {},
          formControl: {},
          tab: {},
          badge: {},
          card: {},
          toggle: {},
          listRow: {},
          emptyState: {},
          actionButton: {},
          search: {},
        },
      },
      {
        badge: 'External',
        description: 'Describe the theme intent here.',
        swatches: ['#07111f', '#0f172a', '#60a5fa', '#e2e8f0'],
      },
    ),
  };
}

export function listThemeRegistryEntries(externalThemes?: ExternalThemeDefinition[]): ThemeRegistryEntry[] {
  const builtin = listBuiltinThemeRegistryEntries();
  const external = (externalThemes ?? readStoredExternalThemes()).map((theme) => createExternalThemeRegistryEntry(theme));
  return [...builtin, ...external];
}

export function resolveThemeRegistryEntry(id: string | null | undefined, externalThemes?: ExternalThemeDefinition[]): ThemeRegistryEntry | null {
  const normalizedId = normalizeThemeRegistryId(id);
  if (!normalizedId) return null;
  return listThemeRegistryEntries(externalThemes).find((entry) => entry.id === normalizedId) ?? null;
}

export function resolveThemeRegistryTheme(id: string | null | undefined, externalThemes?: ExternalThemeDefinition[]): RegionThemeConfig | null {
  return resolveThemeRegistryEntry(id, externalThemes)?.theme ?? null;
}
