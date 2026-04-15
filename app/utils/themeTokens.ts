import {
  DEFAULT_REGION_THEME,
  REGION_COLOR_FIELDS,
  REGION_NAMES,
  REGION_VAR_PREFIXES,
  REGION_THEME_EDITOR_FALLBACKS,
  type RegionColors,
  type RegionName,
  type RegionThemeConfig,
} from './regionTheme';
import {
  listThemeRegistryEntries,
  normalizeThemeRegistryId,
  resolveThemeRegistryTheme,
} from './themeRegistry';

export const DEFAULT_SYNTAX_THEME = 'github-dark';
export const THEME_ROOT_ATTRIBUTE = 'data-region-theme';
export type BaseSemanticThemeToken =
  | 'surface-page'
  | 'surface-page-elevated'
  | 'surface-panel'
  | 'surface-panel-muted'
  | 'surface-panel-elevated'
  | 'surface-panel-hover'
  | 'surface-panel-active'
  | 'surface-overlay'
  | 'surface-danger'
  | 'surface-danger-soft'
  | 'surface-success-soft'
  | 'surface-warning-soft'
  | 'surface-info-soft'
  | 'surface-chip'
  | 'surface-chip-hover'
  | 'surface-dock'
  | 'surface-dock-hover'
  | 'text-primary'
  | 'text-secondary'
  | 'text-muted'
  | 'text-inverse'
  | 'text-danger'
  | 'text-success'
  | 'text-warning'
  | 'text-info'
  | 'border-default'
  | 'border-muted'
  | 'border-strong'
  | 'border-accent'
  | 'accent-primary'
  | 'accent-soft'
  | 'accent-strong'
  | 'status-success'
  | 'status-warning'
  | 'status-danger'
  | 'status-info'
  | 'status-neutral'
  | 'status-git-modified'
  | 'status-git-modified-strong'
  | 'status-git-added'
  | 'status-git-added-strong'
  | 'status-git-deleted'
  | 'status-git-deleted-strong'
  | 'status-git-renamed'
  | 'status-git-renamed-strong'
  | 'status-git-pinned'
  | 'status-git-pinned-strong'
  | 'status-git-archived'
  | 'status-git-attention'
  | 'status-git-connector'
  | 'shadow-panel'
  | 'shadow-floating'
  | 'shadow-glow';

const REGION_THEME_TOKEN_FIELDS = [
  'bg',
  'text',
  'border',
  'accent',
  'control-bg',
  'active-bg',
  'active-text',
  'text-muted',
] as const;

type RegionThemeTokenField = (typeof REGION_THEME_TOKEN_FIELDS)[number];
type RegionThemeTokenPrefix = (typeof REGION_VAR_PREFIXES)[keyof typeof REGION_VAR_PREFIXES];
export type RegionThemeToken = `${RegionThemeTokenPrefix}-${RegionThemeTokenField}`;
export type SemanticThemeToken = BaseSemanticThemeToken | RegionThemeToken;

const BASE_SEMANTIC_THEME_TOKENS = [
  'surface-page',
  'surface-page-elevated',
  'surface-panel',
  'surface-panel-muted',
  'surface-panel-elevated',
  'surface-panel-hover',
  'surface-panel-active',
  'surface-overlay',
  'surface-danger',
  'surface-danger-soft',
  'surface-success-soft',
  'surface-warning-soft',
  'surface-info-soft',
  'surface-chip',
  'surface-chip-hover',
  'surface-dock',
  'surface-dock-hover',
  'text-primary',
  'text-secondary',
  'text-muted',
  'text-inverse',
  'text-danger',
  'text-success',
  'text-warning',
  'text-info',
  'border-default',
  'border-muted',
  'border-strong',
  'border-accent',
  'accent-primary',
  'accent-soft',
  'accent-strong',
  'status-success',
  'status-warning',
  'status-danger',
  'status-info',
  'status-neutral',
  'status-git-modified',
  'status-git-modified-strong',
  'status-git-added',
  'status-git-added-strong',
  'status-git-deleted',
  'status-git-deleted-strong',
  'status-git-renamed',
  'status-git-renamed-strong',
  'status-git-pinned',
  'status-git-pinned-strong',
  'status-git-archived',
  'status-git-attention',
  'status-git-connector',
  'shadow-panel',
  'shadow-floating',
  'shadow-glow',
] as const satisfies readonly BaseSemanticThemeToken[];

export const REGION_THEME_TOKENS = REGION_NAMES.flatMap((regionName) =>
  REGION_THEME_TOKEN_FIELDS.map(
    (field) => `${REGION_VAR_PREFIXES[regionName]}-${field}` as RegionThemeToken,
  ),
) as readonly RegionThemeToken[];

export const SEMANTIC_THEME_TOKENS = [
  ...BASE_SEMANTIC_THEME_TOKENS,
  ...REGION_THEME_TOKENS,
] as readonly SemanticThemeToken[];

export type SemanticTokenMap = Record<SemanticThemeToken, string>;
export type SemanticTokenOverrides = Partial<SemanticTokenMap>;

export type ThemeStorageV2 = {
  version: 2;
  preset: string | null;
  label?: string;
  regions?: Record<RegionName, Partial<RegionColors>>;
  overrides: SemanticTokenOverrides;
};

const DEFAULT_BASE_SEMANTIC_TOKENS: Record<BaseSemanticThemeToken, string> = {
  'surface-page': '#818182',
  'surface-page-elevated': '#909092',
  'surface-panel': 'rgba(15, 23, 42, 0.92)',
  'surface-panel-muted': 'rgba(11, 19, 32, 0.92)',
  'surface-panel-elevated': 'rgba(15, 23, 42, 0.98)',
  'surface-panel-hover': 'rgba(30, 41, 59, 0.78)',
  'surface-panel-active': 'rgba(30, 64, 175, 0.45)',
  'surface-overlay': 'rgba(2, 6, 23, 0.65)',
  'surface-danger': 'rgba(127, 29, 29, 0.35)',
  'surface-danger-soft': 'rgba(248, 113, 113, 0.18)',
  'surface-success-soft': 'rgba(34, 197, 94, 0.18)',
  'surface-warning-soft': 'rgba(250, 204, 21, 0.18)',
  'surface-info-soft': 'rgba(59, 130, 246, 0.18)',
  'surface-chip': 'rgba(15, 23, 42, 0.75)',
  'surface-chip-hover': 'rgba(30, 41, 59, 0.92)',
  'surface-dock': 'color-mix(in srgb, #0b1220 92%, transparent)',
  'surface-dock-hover': 'color-mix(in srgb, #334155 84%, #0f172a)',
  'text-primary': '#e2e8f0',
  'text-secondary': '#cbd5e1',
  'text-muted': '#94a3b8',
  'text-inverse': '#ffffff',
  'text-danger': '#fca5a5',
  'text-success': '#86efac',
  'text-warning': '#fcd34d',
  'text-info': '#93c5fd',
  'border-default': '#334155',
  'border-muted': 'rgba(148, 163, 184, 0.35)',
  'border-strong': '#475569',
  'border-accent': 'rgba(96, 165, 250, 0.45)',
  'accent-primary': '#60a5fa',
  'accent-soft': 'rgba(59, 130, 246, 0.2)',
  'accent-strong': '#2563eb',
  'status-success': '#86efac',
  'status-warning': '#fcd34d',
  'status-danger': '#fca5a5',
  'status-info': '#7dd3fc',
  'status-neutral': '#94a3b8',
  'status-git-modified': '#e2c08d',
  'status-git-modified-strong': '#f0d6a0',
  'status-git-added': '#73c991',
  'status-git-added-strong': '#86efac',
  'status-git-deleted': '#c74e39',
  'status-git-deleted-strong': '#e06050',
  'status-git-renamed': '#4ec9b0',
  'status-git-renamed-strong': '#5ee0c8',
  'status-git-pinned': '#fbbf24',
  'status-git-pinned-strong': '#f59e0b',
  'status-git-archived': '#c4b5fd',
  'status-git-attention': '#93c5fd',
  'status-git-connector': 'rgba(71, 85, 105, 0.46)',
  'shadow-panel': '0 12px 32px rgba(2, 6, 23, 0.45)',
  'shadow-floating': '0 20px 48px rgba(2, 6, 23, 0.55)',
  'shadow-glow': '0 0 0 1px rgba(15, 23, 42, 0.6)',
};

function regionThemeToken(regionName: RegionName, field: keyof RegionColors): RegionThemeToken {
  return `${REGION_VAR_PREFIXES[regionName]}-${fieldToCssSegment(field)}` as RegionThemeToken;
}

function createDefaultRegionSemanticTokens(
  base: Record<BaseSemanticThemeToken, string>,
): Record<RegionThemeToken, string> {
  const defaults = {} as Record<RegionThemeToken, string>;

  function assignRegion(
    regionName: RegionName,
    values: Partial<Record<keyof RegionColors, BaseSemanticThemeToken>>,
  ) {
    for (const field of REGION_COLOR_FIELDS) {
      const token = values[field];
      if (!token) continue;
      defaults[regionThemeToken(regionName, field)] = base[token];
    }
  }

  assignRegion('topPanel', {
    bg: 'surface-panel',
    text: 'text-primary',
    border: 'border-default',
    accent: 'accent-primary',
    controlBg: 'surface-panel-muted',
    activeBg: 'surface-panel-active',
    activeText: 'text-inverse',
    textMuted: 'text-muted',
  });
  assignRegion('sidePanel', {
    bg: 'surface-panel',
    text: 'text-primary',
    border: 'border-default',
    accent: 'accent-primary',
    controlBg: 'surface-panel-muted',
    activeBg: 'surface-panel-active',
    activeText: 'text-inverse',
    textMuted: 'text-muted',
  });
  assignRegion('inputPanel', {
    bg: 'surface-panel',
    text: 'text-primary',
    border: 'border-default',
    accent: 'accent-primary',
    controlBg: 'surface-panel-muted',
    activeBg: 'surface-panel-active',
    activeText: 'text-inverse',
    textMuted: 'text-muted',
  });
  assignRegion('outputPanel', {
    bg: 'surface-panel',
    text: 'text-primary',
    border: 'border-default',
    accent: 'accent-primary',
    controlBg: 'surface-panel-muted',
    activeBg: 'surface-panel-active',
    activeText: 'text-inverse',
    textMuted: 'text-muted',
  });
  assignRegion('topDropdown', {
    bg: 'surface-panel-elevated',
    text: 'text-primary',
    border: 'border-default',
    accent: 'border-accent',
    controlBg: 'surface-panel-muted',
    activeBg: 'surface-panel-active',
    activeText: 'text-inverse',
    textMuted: 'text-muted',
  });
  assignRegion('modalPanel', {
    bg: 'surface-panel-elevated',
    text: 'text-primary',
    border: 'border-default',
    accent: 'border-accent',
    controlBg: 'surface-panel-muted',
    activeBg: 'surface-panel-active',
    activeText: 'text-inverse',
    textMuted: 'text-muted',
  });
  assignRegion('pageBackground', {
    bg: 'surface-page',
    text: 'text-primary',
    border: 'border-default',
    accent: 'accent-primary',
    controlBg: 'surface-page-elevated',
    activeBg: 'surface-panel-active',
    activeText: 'text-inverse',
    textMuted: 'text-muted',
  });
  assignRegion('chatCard', {
    bg: 'surface-panel-elevated',
    text: 'text-primary',
    border: 'border-muted',
    accent: 'border-accent',
    controlBg: 'surface-chip',
    activeBg: 'surface-chip-hover',
    activeText: 'text-inverse',
    textMuted: 'text-muted',
  });

  return defaults;
}

const DEFAULT_REGION_SEMANTIC_TOKENS = createDefaultRegionSemanticTokens(DEFAULT_BASE_SEMANTIC_TOKENS);

const DEFAULT_SEMANTIC_TOKENS: SemanticTokenMap = {
  ...DEFAULT_BASE_SEMANTIC_TOKENS,
  ...DEFAULT_REGION_SEMANTIC_TOKENS,
};

function regionColorValue(region: Partial<RegionColors> | undefined, field: keyof RegionColors) {
  return region?.[field];
}

function firstDefined(...values: Array<string | undefined>) {
  return values.find((value) => typeof value === 'string' && value.length > 0);
}

function normalizeColorValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function fieldToCssSegment(field: keyof RegionColors): string {
  switch (field) {
    case 'controlBg':
      return 'control-bg';
    case 'activeBg':
      return 'active-bg';
    case 'activeText':
      return 'active-text';
    case 'textMuted':
      return 'text-muted';
    default:
      return field;
  }
}

function cloneRegionThemeRegions(
  regions: Record<RegionName, Partial<RegionColors>>,
): Record<RegionName, Partial<RegionColors>> {
  return Object.fromEntries(
    REGION_NAMES.map((regionName) => [regionName, { ...(regions[regionName] ?? {}) }]),
  ) as Record<RegionName, Partial<RegionColors>>;
}

function normalizeStoredRegions(value: unknown): Record<RegionName, Partial<RegionColors>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    REGION_NAMES.map((regionName) => {
      const regionValue = record[regionName];
      const regionRecord =
        regionValue && typeof regionValue === 'object' && !Array.isArray(regionValue)
          ? (regionValue as Record<string, unknown>)
          : {};

      const normalizedRegion = Object.fromEntries(
        REGION_COLOR_FIELDS.flatMap((field) => {
          const normalized = normalizeColorValue(regionRecord[field]);
          if (!normalized) return [];
          return [[field, normalized]];
        }),
      ) as Partial<RegionColors>;

      return [regionName, normalizedRegion];
    }),
  ) as Record<RegionName, Partial<RegionColors>>;
}

export function createDefaultSemanticThemeTokens(): SemanticTokenMap {
  return { ...DEFAULT_SEMANTIC_TOKENS };
}

export function semanticTokenCssVariable(token: SemanticThemeToken): string {
  return `--theme-${token}`;
}

export function regionThemeCssVariable(regionName: RegionName, field: keyof RegionColors): string {
  return semanticTokenCssVariable(regionThemeToken(regionName, field));
}

export function regionThemeToSemanticOverrides(theme: RegionThemeConfig | null | undefined): SemanticTokenOverrides {
  if (!theme) return {};

  const top = theme.regions.topPanel;
  const side = theme.regions.sidePanel;
  const input = theme.regions.inputPanel;
  const output = theme.regions.outputPanel;
  const dropdown = theme.regions.topDropdown;
  const modal = theme.regions.modalPanel;
  const page = theme.regions.pageBackground;
  const chat = theme.regions.chatCard;
  const modalActiveBg = firstDefined(regionColorValue(modal, 'activeBg'));
  const pageBg = firstDefined(regionColorValue(page, 'bg'));

  const overrides: SemanticTokenOverrides = {
    'surface-page': firstDefined(regionColorValue(page, 'bg')),
    'surface-page-elevated': firstDefined(regionColorValue(page, 'controlBg'), regionColorValue(page, 'bg')),
    'surface-panel': firstDefined(regionColorValue(top, 'bg'), regionColorValue(side, 'bg'), regionColorValue(output, 'bg')),
    'surface-panel-muted': firstDefined(
      regionColorValue(top, 'controlBg'),
      regionColorValue(side, 'controlBg'),
      regionColorValue(output, 'controlBg'),
      regionColorValue(input, 'controlBg'),
    ),
    'surface-panel-elevated': firstDefined(regionColorValue(modal, 'bg'), regionColorValue(dropdown, 'bg'), regionColorValue(chat, 'bg')),
    'surface-panel-hover': firstDefined(
      regionColorValue(side, 'controlBg'),
      regionColorValue(top, 'controlBg'),
      regionColorValue(modal, 'controlBg'),
      regionColorValue(chat, 'controlBg'),
    ),
    'surface-panel-active': firstDefined(
      regionColorValue(top, 'activeBg'),
      regionColorValue(side, 'activeBg'),
      regionColorValue(output, 'activeBg'),
      regionColorValue(modal, 'activeBg'),
    ),
    'surface-overlay': modalActiveBg
      ? `color-mix(in srgb, ${modalActiveBg} 55%, transparent)`
      : firstDefined(
          pageBg ? `color-mix(in srgb, ${pageBg} 82%, transparent)` : undefined,
          'rgba(2, 6, 23, 0.65)',
        ),
    'text-primary': firstDefined(regionColorValue(top, 'text'), regionColorValue(side, 'text'), regionColorValue(output, 'text')),
    'text-secondary': firstDefined(regionColorValue(dropdown, 'text'), regionColorValue(modal, 'text'), regionColorValue(chat, 'text')),
    'text-muted': firstDefined(
      regionColorValue(top, 'textMuted'),
      regionColorValue(side, 'textMuted'),
      regionColorValue(output, 'textMuted'),
      regionColorValue(modal, 'textMuted'),
    ),
    'text-inverse': firstDefined(
      regionColorValue(top, 'activeText'),
      regionColorValue(side, 'activeText'),
      regionColorValue(modal, 'activeText'),
    ),
    'border-default': firstDefined(regionColorValue(top, 'border'), regionColorValue(side, 'border'), regionColorValue(output, 'border')),
    'border-muted': firstDefined(regionColorValue(dropdown, 'border'), regionColorValue(chat, 'border'), regionColorValue(modal, 'border')),
    'border-strong': firstDefined(regionColorValue(page, 'border'), regionColorValue(modal, 'border')),
    'border-accent': firstDefined(regionColorValue(top, 'accent'), regionColorValue(side, 'accent'), regionColorValue(modal, 'accent')),
    'accent-primary': firstDefined(regionColorValue(top, 'accent'), regionColorValue(side, 'accent'), regionColorValue(output, 'accent')),
    'accent-soft': firstDefined(regionColorValue(top, 'activeBg'), regionColorValue(side, 'activeBg'), regionColorValue(modal, 'activeBg')),
    'surface-chip': firstDefined(regionColorValue(chat, 'controlBg'), regionColorValue(side, 'controlBg'), regionColorValue(top, 'controlBg')),
    'surface-chip-hover': firstDefined(regionColorValue(chat, 'activeBg'), regionColorValue(side, 'activeBg'), regionColorValue(top, 'activeBg')),
    'surface-dock': firstDefined(regionColorValue(page, 'controlBg'), regionColorValue(page, 'bg')),
    'surface-dock-hover': firstDefined(regionColorValue(page, 'activeBg'), regionColorValue(page, 'controlBg')),
  };

  return Object.fromEntries(
    Object.entries(overrides).flatMap(([token, value]) => {
      const normalized = normalizeColorValue(value);
      if (!normalized) return [];
      return [[token, normalized]];
    }),
  ) as SemanticTokenOverrides;
}

export function resolveThemeStoragePreset(storage: ThemeStorageV2 | null | undefined) {
  return normalizeThemeRegistryId(storage?.preset ?? null);
}

export function isThemeStorageV2(value: unknown): value is ThemeStorageV2 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 2) return false;
  if (record.preset !== null && typeof record.preset !== 'string') return false;
  if (!record.overrides || typeof record.overrides !== 'object' || Array.isArray(record.overrides)) return false;
  return true;
}

export function normalizeThemeStorage(input: unknown): ThemeStorageV2 | null {
  if (!isThemeStorageV2(input)) return null;
  const overrides = Object.fromEntries(
    Object.entries(input.overrides).flatMap(([token, value]) => {
      if (!SEMANTIC_THEME_TOKENS.includes(token as SemanticThemeToken)) return [];
      const normalized = normalizeColorValue(value);
      if (!normalized) return [];
      return [[token, normalized]];
    }),
  ) as SemanticTokenOverrides;

  return {
    version: 2,
    preset: input.preset,
    label: typeof input.label === 'string' ? input.label : undefined,
    regions: normalizeStoredRegions(input.regions),
    overrides,
  };
}

export function regionThemeToStorage(theme: RegionThemeConfig | null | undefined): ThemeStorageV2 | null {
  if (!theme) return null;
  const semanticOverrides = regionThemeToSemanticOverrides(theme);
  const regionOverrides = Object.fromEntries(
    REGION_NAMES.flatMap((regionName) => {
      const region = theme.regions[regionName] ?? {};
      return REGION_COLOR_FIELDS.flatMap((field) => {
        const value = normalizeColorValue(region[field]);
        if (!value) return [];
        return [[regionThemeToken(regionName, field), value]];
      });
    }),
  ) as SemanticTokenOverrides;

  return {
    version: 2,
    preset: normalizeThemeRegistryId(theme.name),
    label: theme.label,
    regions: cloneRegionThemeRegions(theme.regions),
    overrides: {
      ...semanticOverrides,
      ...regionOverrides,
    },
  };
}

export function storageToRegionTheme(storage: ThemeStorageV2 | null | undefined): RegionThemeConfig | null {
  if (!storage) return null;

  const preset = resolveThemeRegistryTheme(storage.preset ?? null);
  const normalizedRegions = storage.regions ? cloneRegionThemeRegions(storage.regions) : undefined;

  if (!normalizedRegions) {
    const tokenRegions = Object.fromEntries(
      REGION_NAMES.map((regionName) => {
        const region = Object.fromEntries(
          REGION_COLOR_FIELDS.flatMap((field) => {
            const value = normalizeColorValue(storage.overrides[regionThemeToken(regionName, field)]);
            if (!value) return [];
            return [[field, value]];
          }),
        ) as Partial<RegionColors>;

        return [regionName, region];
      }),
    ) as Record<RegionName, Partial<RegionColors>>;

    const hasAnyTokenRegion = REGION_NAMES.some((regionName) => Object.keys(tokenRegions[regionName] ?? {}).length > 0);
    if (hasAnyTokenRegion) {
      return {
        name: storage.preset ?? 'custom',
        label:
          storage.label ??
          (storage.preset ? resolveThemeRegistryTheme(storage.preset)?.label : undefined) ??
          'Custom',
        regions: tokenRegions,
      };
    }
  }

  if (normalizedRegions) {
    return {
        name: storage.preset ?? 'custom',
        label:
          storage.label ??
          (storage.preset ? resolveThemeRegistryTheme(storage.preset)?.label : undefined) ??
          'Custom',
        regions: normalizedRegions,
    };
  }

  if (preset) {
    return {
      name: preset.name,
      label: preset.label,
      regions: cloneRegionThemeRegions(preset.regions),
    };
  }

  return {
    name: storage.preset ?? 'custom',
    label: storage.label ?? 'Custom',
    regions: cloneRegionThemeRegions(DEFAULT_REGION_THEME.regions),
  };
}

export function migrateLegacyRegionThemeStorage(input: unknown): ThemeStorageV2 | null {
  const normalized = normalizeThemeStorage(input);
  if (normalized) return normalized;

  if (!input || typeof input !== 'object') return null;
  const record = input as Partial<RegionThemeConfig>;
  if (typeof record.name !== 'string' || typeof record.label !== 'string' || !record.regions) {
    return null;
  }

  return regionThemeToStorage(record as RegionThemeConfig);
}

export function resolveThemeStorageLabel(storage: ThemeStorageV2 | null | undefined): string {
  if (!storage) return DEFAULT_REGION_THEME.label;
  if (storage.label) return storage.label;
  const preset = resolveThemeRegistryTheme(storage.preset ?? null);
  return preset?.label ?? 'Custom';
}

export function createThemeStorageFromEditor(overrides: SemanticTokenOverrides, preset: string | null, label?: string): ThemeStorageV2 {
  const normalizedOverrides = Object.fromEntries(
    Object.entries(overrides).flatMap(([token, value]) => {
      if (!SEMANTIC_THEME_TOKENS.includes(token as SemanticThemeToken)) return [];
      const normalized = normalizeColorValue(value);
      if (!normalized) return [];
      return [[token, normalized]];
    }),
  ) as SemanticTokenOverrides;

  return {
    version: 2,
    preset,
    label,
    regions: undefined,
    overrides: normalizedOverrides,
  };
}

export function createEditorFallbackSemanticTokens(): SemanticTokenOverrides {
  return {
    'surface-page': REGION_THEME_EDITOR_FALLBACKS.bg,
    'surface-page-elevated': REGION_THEME_EDITOR_FALLBACKS.controlBg,
    'surface-panel': REGION_THEME_EDITOR_FALLBACKS.bg,
    'surface-panel-muted': REGION_THEME_EDITOR_FALLBACKS.controlBg,
    'surface-panel-elevated': REGION_THEME_EDITOR_FALLBACKS.bg,
    'surface-panel-hover': REGION_THEME_EDITOR_FALLBACKS.controlBg,
    'surface-panel-active': REGION_THEME_EDITOR_FALLBACKS.activeBg,
    'surface-overlay': REGION_THEME_EDITOR_FALLBACKS.activeBg,
    'text-primary': REGION_THEME_EDITOR_FALLBACKS.text,
    'text-secondary': REGION_THEME_EDITOR_FALLBACKS.text,
    'text-muted': REGION_THEME_EDITOR_FALLBACKS.textMuted,
    'text-inverse': REGION_THEME_EDITOR_FALLBACKS.activeText,
    'border-default': REGION_THEME_EDITOR_FALLBACKS.border,
    'border-muted': REGION_THEME_EDITOR_FALLBACKS.border,
    'border-strong': REGION_THEME_EDITOR_FALLBACKS.border,
    'border-accent': REGION_THEME_EDITOR_FALLBACKS.accent,
    'accent-primary': REGION_THEME_EDITOR_FALLBACKS.accent,
    'accent-soft': REGION_THEME_EDITOR_FALLBACKS.activeBg,
  };
}

export function buildRegionCompatibilityCss(): string {
  const rootLines = SEMANTIC_THEME_TOKENS.map((token) => `  ${semanticTokenCssVariable(token)}: ${DEFAULT_SEMANTIC_TOKENS[token]};`);
  const presetBlocks = Object.entries(buildPresetTokenOverrides())
    .filter(([presetName]) => presetName !== DEFAULT_REGION_THEME.name)
    .map(([presetName, overrides]) => {
      const lines = Object.entries(createSemanticTokenSnapshot(overrides)).map(
        ([token, value]) => `  ${semanticTokenCssVariable(token as SemanticThemeToken)}: ${value};`,
      );
      return [`:root[${THEME_ROOT_ATTRIBUTE}="${presetName}"] {`, ...lines, '}'].join('\n');
    });

  return [
    ':root {',
    ...rootLines,
    '}',
    ...presetBlocks,
  ].join('\n');
}

export function buildPresetTokenOverrides(): Record<string, SemanticTokenOverrides> {
  const result: Record<string, SemanticTokenOverrides> = {};
  for (const entry of listThemeRegistryEntries([])) {
    result[entry.id] = regionThemeToStorage(entry.theme)?.overrides ?? {};
  }
  return result;
}

export function createSemanticTokenSnapshot(overrides?: SemanticTokenOverrides): SemanticTokenMap {
  const base = createDefaultSemanticThemeTokens();
  if (!overrides) return base;
  for (const token of SEMANTIC_THEME_TOKENS) {
    const value = normalizeColorValue(overrides[token]);
    if (value) {
      base[token] = value;
    }
  }
  return base;
}

export function extractSemanticTokenOverrides(storage: ThemeStorageV2 | null | undefined): SemanticTokenOverrides {
  return storage?.overrides ?? {};
}

export function extractRegionTokenOverrides(
  theme: Record<RegionName, Partial<RegionColors>> | RegionThemeConfig | null | undefined,
): Record<string, string> {
  if (!theme) {
    return {};
  }

  const regions = 'regions' in theme ? theme.regions : theme;

  return Object.fromEntries(
    REGION_NAMES.flatMap((regionName) => {
      const region = regions[regionName] ?? {};
      return REGION_COLOR_FIELDS.flatMap((field) => {
        const value = normalizeColorValue(region[field]);
        if (!value) return [];
        return [[regionThemeCssVariable(regionName, field), value]];
      });
    }),
  );
}

export function isCustomThemeStorage(storage: ThemeStorageV2 | null | undefined): boolean {
  if (!storage) return false;
  return storage.preset == null || storage.preset === 'custom';
}

export function getRegionEditorFields(regionName: RegionName): Array<keyof RegionColors> {
  if (regionName === 'pageBackground') {
    return ['bg'];
  }
  if (regionName === 'chatCard') {
    return ['bg', 'border', 'textMuted'];
  }
  return [...REGION_COLOR_FIELDS];
}
