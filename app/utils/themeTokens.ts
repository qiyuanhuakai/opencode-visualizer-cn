import {
  DEFAULT_REGION_THEME,
  REGION_COLOR_FIELDS,
  REGION_NAMES,
  REGION_VAR_PREFIXES,
  REGION_THEME_EDITOR_FALLBACKS,
  THEME_COMPONENT_FIELDS,
  type ChipThemeColors,
  type DockThemeColors,
  type DropdownThemeColors,
  type EmptyStateThemeColors,
  type ActionButtonThemeColors,
  type FormControlThemeColors,
  type BadgeThemeColors,
  type CardThemeColors,
  type RegionColors,
  type RegionName,
  type RegionThemeConfig,
  type SearchThemeColors,
  type TabThemeColors,
  type ThemeComponentConfig,
  type ThemeComponentName,
  type ToggleThemeColors,
  type ListRowThemeColors,
  type IconActionThemeColors,
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
  | 'shadow-glow'
  | 'dropdown-bg'
  | 'dropdown-border'
  | 'dropdown-text'
  | 'dropdown-text-muted'
  | 'dropdown-control-bg'
  | 'dropdown-hover-bg'
  | 'dropdown-active-bg'
  | 'dropdown-accent'
  | 'dropdown-shadow'
  | 'chip-border-neutral'
  | 'chip-border-subtle'
  | 'chip-bg-neutral'
  | 'chip-bg-hover'
  | 'chip-fg-neutral'
  | 'icon-action-border'
  | 'icon-action-bg'
  | 'icon-action-bg-hover'
  | 'dock-tray-bg'
  | 'dock-tray-border'
  | 'dock-tray-shadow'
  | 'dock-thumb'
  | 'dock-chip-bg'
  | 'dock-chip-hover-bg'
  | 'dock-chip-border'
  | 'dock-chip-text'
  | 'dock-handle'
  | 'dock-handle-hover'
  | 'dock-handle-shadow'
  | 'form-control-bg'
  | 'form-control-border'
  | 'form-control-text'
  | 'form-control-placeholder'
  | 'form-control-focus-border'
  | 'form-control-focus-ring'
  | 'form-button-bg'
  | 'form-button-border'
  | 'form-button-text'
  | 'form-button-hover-bg'
  | 'form-button-primary-bg'
  | 'form-button-primary-border'
  | 'form-button-primary-text'
  | 'form-button-primary-hover-bg'
  | 'tab-bg'
  | 'tab-border'
  | 'tab-text'
  | 'tab-hover-bg'
  | 'tab-active-bg'
  | 'tab-active-border'
  | 'tab-active-text'
  | 'badge-bg'
  | 'badge-border'
  | 'badge-text'
  | 'badge-accent-bg'
  | 'badge-accent-border'
  | 'badge-accent-text'
  | 'card-bg'
  | 'card-border'
  | 'card-shadow'
  | 'card-hover-bg'
  | 'card-active-bg'
  | 'toggle-track'
  | 'toggle-track-border'
  | 'toggle-thumb'
  | 'toggle-active-track'
  | 'toggle-active-thumb'
  | 'list-row-bg'
  | 'list-row-border'
  | 'list-row-text'
  | 'list-row-text-muted'
  | 'list-row-hover-bg'
  | 'list-row-active-bg'
  | 'empty-state-bg'
  | 'empty-state-text'
  | 'empty-state-text-muted'
  | 'empty-state-icon'
  | 'action-button-bg'
  | 'action-button-border'
  | 'action-button-text'
  | 'action-button-hover-bg'
  | 'action-button-accent-bg'
  | 'action-button-accent-border'
  | 'action-button-accent-text'
  | 'search-bg'
  | 'search-border'
  | 'search-text'
  | 'search-placeholder'
  | 'search-icon'
  | 'search-focus-bg';

const COMPONENT_THEME_TOKEN_FIELDS = {
  dropdown: ['bg', 'border', 'text', 'text-muted', 'control-bg', 'hover-bg', 'active-bg', 'accent', 'shadow'],
  chip: ['border-neutral', 'border-subtle', 'bg-neutral', 'bg-hover', 'fg-neutral'],
  'icon-action': ['border', 'bg', 'bg-hover'],
  dock: ['tray-bg', 'tray-border', 'tray-shadow', 'thumb', 'chip-bg', 'chip-hover-bg', 'chip-border', 'chip-text', 'handle', 'handle-hover', 'handle-shadow'],
  'form-control': ['bg', 'border', 'text', 'placeholder', 'focus-border', 'focus-ring', 'button-bg', 'button-border', 'button-text', 'button-hover-bg', 'button-primary-bg', 'button-primary-border', 'button-primary-text', 'button-primary-hover-bg'],
  tab: ['bg', 'border', 'text', 'hover-bg', 'active-bg', 'active-border', 'active-text'],
  badge: ['bg', 'border', 'text', 'accent-bg', 'accent-border', 'accent-text'],
  card: ['bg', 'border', 'shadow', 'hover-bg', 'active-bg'],
  toggle: ['track', 'track-border', 'thumb', 'active-track', 'active-thumb'],
  'list-row': ['bg', 'border', 'text', 'text-muted', 'hover-bg', 'active-bg'],
  'empty-state': ['bg', 'text', 'text-muted', 'icon'],
  'action-button': ['bg', 'border', 'text', 'hover-bg', 'accent-bg', 'accent-border', 'accent-text'],
  search: ['bg', 'border', 'text', 'placeholder', 'icon', 'focus-bg'],
} as const;

type ComponentThemeTokenPrefix = keyof typeof COMPONENT_THEME_TOKEN_FIELDS;
type ComponentThemeTokenField<Prefix extends ComponentThemeTokenPrefix> =
  (typeof COMPONENT_THEME_TOKEN_FIELDS)[Prefix][number];
export type ComponentThemeToken = {
  [Prefix in ComponentThemeTokenPrefix]: `${Prefix}-${ComponentThemeTokenField<Prefix>}`;
}[ComponentThemeTokenPrefix];

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
export type SemanticThemeToken = BaseSemanticThemeToken | RegionThemeToken | ComponentThemeToken;

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
  'dropdown-bg',
  'dropdown-border',
  'dropdown-text',
  'dropdown-text-muted',
  'dropdown-control-bg',
  'dropdown-hover-bg',
  'dropdown-active-bg',
  'dropdown-accent',
  'dropdown-shadow',
  'chip-border-neutral',
  'chip-border-subtle',
  'chip-bg-neutral',
  'chip-bg-hover',
  'chip-fg-neutral',
  'icon-action-border',
  'icon-action-bg',
  'icon-action-bg-hover',
  'dock-tray-bg',
  'dock-tray-border',
  'dock-tray-shadow',
  'dock-thumb',
  'dock-chip-bg',
  'dock-chip-hover-bg',
  'dock-chip-border',
  'dock-chip-text',
  'dock-handle',
  'dock-handle-hover',
  'dock-handle-shadow',
  'form-control-bg',
  'form-control-border',
  'form-control-text',
  'form-control-placeholder',
  'form-control-focus-border',
  'form-control-focus-ring',
  'form-button-bg',
  'form-button-border',
  'form-button-text',
  'form-button-hover-bg',
  'form-button-primary-bg',
  'form-button-primary-border',
  'form-button-primary-text',
  'form-button-primary-hover-bg',
  'tab-bg',
  'tab-border',
  'tab-text',
  'tab-hover-bg',
  'tab-active-bg',
  'tab-active-border',
  'tab-active-text',
  'badge-bg',
  'badge-border',
  'badge-text',
  'badge-accent-bg',
  'badge-accent-border',
  'badge-accent-text',
  'card-bg',
  'card-border',
  'card-shadow',
  'card-hover-bg',
  'card-active-bg',
  'toggle-track',
  'toggle-track-border',
  'toggle-thumb',
  'toggle-active-track',
  'toggle-active-thumb',
  'list-row-bg',
  'list-row-border',
  'list-row-text',
  'list-row-text-muted',
  'list-row-hover-bg',
  'list-row-active-bg',
  'empty-state-bg',
  'empty-state-text',
  'empty-state-text-muted',
  'empty-state-icon',
  'action-button-bg',
  'action-button-border',
  'action-button-text',
  'action-button-hover-bg',
  'action-button-accent-bg',
  'action-button-accent-border',
  'action-button-accent-text',
  'search-bg',
  'search-border',
  'search-text',
  'search-placeholder',
  'search-icon',
  'search-focus-bg',
] as const satisfies readonly BaseSemanticThemeToken[];

export const REGION_THEME_TOKENS = REGION_NAMES.flatMap((regionName) =>
  REGION_THEME_TOKEN_FIELDS.map(
    (field) => `${REGION_VAR_PREFIXES[regionName]}-${field}` as RegionThemeToken,
  ),
) as readonly RegionThemeToken[];

export const COMPONENT_THEME_TOKENS = Object.entries(COMPONENT_THEME_TOKEN_FIELDS).flatMap(
  ([prefix, fields]) => fields.map((field) => `${prefix}-${field}` as ComponentThemeToken),
) as readonly ComponentThemeToken[];

export const SEMANTIC_THEME_TOKENS = [
  ...BASE_SEMANTIC_THEME_TOKENS,
  ...REGION_THEME_TOKENS,
  ...COMPONENT_THEME_TOKENS,
] as readonly SemanticThemeToken[];

export type SemanticTokenMap = Record<SemanticThemeToken, string>;
export type SemanticTokenOverrides = Partial<SemanticTokenMap>;

export type ThemeStorageV2 = {
  version: 2;
  preset: string | null;
  label?: string;
  regions?: Record<RegionName, Partial<RegionColors>>;
  components?: ThemeComponentConfig;
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
  'dropdown-bg': 'rgba(2, 6, 23, 0.98)',
  'dropdown-border': '#334155',
  'dropdown-text': '#e2e8f0',
  'dropdown-text-muted': '#94a3b8',
  'dropdown-control-bg': '#0b1320',
  'dropdown-hover-bg': 'rgba(15, 23, 42, 0.9)',
  'dropdown-active-bg': 'rgba(59, 130, 246, 0.2)',
  'dropdown-accent': 'rgba(96, 165, 250, 0.45)',
  'dropdown-shadow': '0 12px 24px rgba(2, 6, 23, 0.45)',
  'chip-border-neutral': 'rgba(148, 163, 184, 0.65)',
  'chip-border-subtle': 'color-mix(in srgb, rgba(148, 163, 184, 0.5) 80%, transparent)',
  'chip-bg-neutral': 'rgba(15, 23, 42, 0.75)',
  'chip-bg-hover': 'rgba(30, 41, 59, 0.92)',
  'chip-fg-neutral': '#bfdbfe',
  'icon-action-border': '#334155',
  'icon-action-bg': '#111a2c',
  'icon-action-bg-hover': '#1d2a45',
  'dock-tray-bg': 'color-mix(in srgb, #0b1220 92%, transparent)',
  'dock-tray-border': 'rgba(148, 163, 184, 0.25)',
  'dock-tray-shadow': '0 6px 18px rgba(2, 6, 23, 0.32)',
  'dock-thumb': 'rgba(148, 163, 184, 0.5)',
  'dock-chip-bg': 'color-mix(in srgb, #1e293b 82%, #0f172a)',
  'dock-chip-hover-bg': 'color-mix(in srgb, #334155 84%, #0f172a)',
  'dock-chip-border': 'rgba(148, 163, 184, 0.35)',
  'dock-chip-text': '#e2e8f0',
  'dock-handle': 'rgba(148, 163, 184, 0.6)',
  'dock-handle-hover': 'rgba(226, 232, 240, 0.7)',
  'dock-handle-shadow': '0 0 0 1px rgba(15, 23, 42, 0.6)',
  'form-control-bg': 'rgba(2, 6, 23, 0.6)',
  'form-control-border': '#334155',
  'form-control-text': '#e2e8f0',
  'form-control-placeholder': '#475569',
  'form-control-focus-border': '#475569',
  'form-control-focus-ring': '0 0 0 1px rgba(59, 130, 246, 0.35)',
  'form-button-bg': 'rgba(15, 23, 42, 0.72)',
  'form-button-border': '#334155',
  'form-button-text': '#e2e8f0',
  'form-button-hover-bg': 'rgba(30, 41, 59, 0.92)',
  'form-button-primary-bg': '#1e40af',
  'form-button-primary-border': '#2563eb',
  'form-button-primary-text': '#e2e8f0',
  'form-button-primary-hover-bg': '#2563eb',
  'tab-bg': 'rgba(15, 23, 42, 0.7)',
  'tab-border': 'rgba(100, 116, 139, 0.35)',
  'tab-text': '#94a3b8',
  'tab-hover-bg': 'rgba(148, 163, 184, 0.12)',
  'tab-active-bg': 'rgba(30, 64, 175, 0.45)',
  'tab-active-border': 'rgba(96, 165, 250, 0.6)',
  'tab-active-text': '#e2e8f0',
  'badge-bg': 'rgba(15, 23, 42, 0.78)',
  'badge-border': 'rgba(148, 163, 184, 0.45)',
  'badge-text': '#cbd5e1',
  'badge-accent-bg': 'rgba(30, 64, 175, 0.25)',
  'badge-accent-border': 'rgba(59, 130, 246, 0.5)',
  'badge-accent-text': '#93c5fd',
  'card-bg': 'rgba(15, 23, 42, 0.6)',
  'card-border': 'rgba(71, 85, 105, 0.5)',
  'card-shadow': '0 10px 24px rgba(2, 6, 23, 0.35)',
  'card-hover-bg': 'rgba(30, 41, 59, 0.78)',
  'card-active-bg': 'rgba(30, 64, 175, 0.25)',
  'toggle-track': '#334155',
  'toggle-track-border': 'rgba(100, 116, 139, 0.55)',
  'toggle-thumb': '#94a3b8',
  'toggle-active-track': '#3b82f6',
  'toggle-active-thumb': '#ffffff',
  'list-row-bg': 'rgba(30, 41, 59, 0.55)',
  'list-row-border': 'rgba(148, 163, 184, 0.12)',
  'list-row-text': '#e2e8f0',
  'list-row-text-muted': '#94a3b8',
  'list-row-hover-bg': 'rgba(30, 41, 59, 0.92)',
  'list-row-active-bg': 'rgba(30, 64, 175, 0.2)',
  'empty-state-bg': 'transparent',
  'empty-state-text': '#94a3b8',
  'empty-state-text-muted': '#64748b',
  'empty-state-icon': '#64748b',
  'action-button-bg': 'rgba(15, 23, 42, 0.82)',
  'action-button-border': '#334155',
  'action-button-text': '#e2e8f0',
  'action-button-hover-bg': 'rgba(30, 41, 59, 0.92)',
  'action-button-accent-bg': 'rgba(59, 130, 246, 0.18)',
  'action-button-accent-border': 'rgba(96, 165, 250, 0.35)',
  'action-button-accent-text': '#dbeafe',
  'search-bg': 'rgba(15, 23, 42, 0.82)',
  'search-border': '#334155',
  'search-text': '#e2e8f0',
  'search-placeholder': '#64748b',
  'search-icon': '#64748b',
  'search-focus-bg': 'rgba(30, 64, 175, 0.15)',
};

const COMPONENT_THEME_TOKEN_MAP = {
  dropdown: {
    bg: 'dropdown-bg',
    border: 'dropdown-border',
    text: 'dropdown-text',
    textMuted: 'dropdown-text-muted',
    controlBg: 'dropdown-control-bg',
    hoverBg: 'dropdown-hover-bg',
    activeBg: 'dropdown-active-bg',
    accent: 'dropdown-accent',
    shadow: 'dropdown-shadow',
  } satisfies Record<keyof DropdownThemeColors, BaseSemanticThemeToken>,
  chip: {
    borderNeutral: 'chip-border-neutral',
    borderSubtle: 'chip-border-subtle',
    bgNeutral: 'chip-bg-neutral',
    bgHover: 'chip-bg-hover',
    fgNeutral: 'chip-fg-neutral',
  } satisfies Record<keyof ChipThemeColors, BaseSemanticThemeToken>,
  iconAction: {
    border: 'icon-action-border',
    bg: 'icon-action-bg',
    bgHover: 'icon-action-bg-hover',
  } satisfies Record<keyof IconActionThemeColors, BaseSemanticThemeToken>,
  dock: {
    trayBg: 'dock-tray-bg',
    trayBorder: 'dock-tray-border',
    trayShadow: 'dock-tray-shadow',
    thumb: 'dock-thumb',
    chipBg: 'dock-chip-bg',
    chipHoverBg: 'dock-chip-hover-bg',
    chipBorder: 'dock-chip-border',
    chipText: 'dock-chip-text',
    handle: 'dock-handle',
    handleHover: 'dock-handle-hover',
    handleShadow: 'dock-handle-shadow',
  } satisfies Record<keyof DockThemeColors, BaseSemanticThemeToken>,
  formControl: {
    bg: 'form-control-bg',
    border: 'form-control-border',
    text: 'form-control-text',
    placeholder: 'form-control-placeholder',
    focusBorder: 'form-control-focus-border',
    focusRing: 'form-control-focus-ring',
    buttonBg: 'form-button-bg',
    buttonBorder: 'form-button-border',
    buttonText: 'form-button-text',
    buttonHoverBg: 'form-button-hover-bg',
    buttonPrimaryBg: 'form-button-primary-bg',
    buttonPrimaryBorder: 'form-button-primary-border',
    buttonPrimaryText: 'form-button-primary-text',
    buttonPrimaryHoverBg: 'form-button-primary-hover-bg',
  } satisfies Record<keyof FormControlThemeColors, BaseSemanticThemeToken>,
  tab: {
    bg: 'tab-bg',
    border: 'tab-border',
    text: 'tab-text',
    hoverBg: 'tab-hover-bg',
    activeBg: 'tab-active-bg',
    activeBorder: 'tab-active-border',
    activeText: 'tab-active-text',
  } satisfies Record<keyof TabThemeColors, BaseSemanticThemeToken>,
  badge: {
    bg: 'badge-bg',
    border: 'badge-border',
    text: 'badge-text',
    accentBg: 'badge-accent-bg',
    accentBorder: 'badge-accent-border',
    accentText: 'badge-accent-text',
  } satisfies Record<keyof BadgeThemeColors, BaseSemanticThemeToken>,
  card: {
    bg: 'card-bg',
    border: 'card-border',
    shadow: 'card-shadow',
    hoverBg: 'card-hover-bg',
    activeBg: 'card-active-bg',
  } satisfies Record<keyof CardThemeColors, BaseSemanticThemeToken>,
  toggle: {
    track: 'toggle-track',
    trackBorder: 'toggle-track-border',
    thumb: 'toggle-thumb',
    activeTrack: 'toggle-active-track',
    activeThumb: 'toggle-active-thumb',
  } satisfies Record<keyof ToggleThemeColors, BaseSemanticThemeToken>,
  listRow: {
    bg: 'list-row-bg',
    border: 'list-row-border',
    text: 'list-row-text',
    textMuted: 'list-row-text-muted',
    hoverBg: 'list-row-hover-bg',
    activeBg: 'list-row-active-bg',
  } satisfies Record<keyof ListRowThemeColors, BaseSemanticThemeToken>,
  emptyState: {
    bg: 'empty-state-bg',
    text: 'empty-state-text',
    textMuted: 'empty-state-text-muted',
    icon: 'empty-state-icon',
  } satisfies Record<keyof EmptyStateThemeColors, BaseSemanticThemeToken>,
  actionButton: {
    bg: 'action-button-bg',
    border: 'action-button-border',
    text: 'action-button-text',
    hoverBg: 'action-button-hover-bg',
    accentBg: 'action-button-accent-bg',
    accentBorder: 'action-button-accent-border',
    accentText: 'action-button-accent-text',
  } satisfies Record<keyof ActionButtonThemeColors, BaseSemanticThemeToken>,
  search: {
    bg: 'search-bg',
    border: 'search-border',
    text: 'search-text',
    placeholder: 'search-placeholder',
    icon: 'search-icon',
    focusBg: 'search-focus-bg',
  } satisfies Record<keyof SearchThemeColors, BaseSemanticThemeToken>,
} as const;

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
  assignRegion('loginScreen', {
    bg: 'surface-panel-elevated',
    text: 'text-primary',
    border: 'border-default',
    accent: 'accent-primary',
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
const DEFAULT_COMPONENT_SEMANTIC_TOKENS = createDefaultComponentSemanticTokens(DEFAULT_BASE_SEMANTIC_TOKENS);

const DEFAULT_SEMANTIC_TOKENS: SemanticTokenMap = {
  ...DEFAULT_BASE_SEMANTIC_TOKENS,
  ...DEFAULT_REGION_SEMANTIC_TOKENS,
  ...Object.fromEntries(
    Object.entries(DEFAULT_COMPONENT_SEMANTIC_TOKENS).filter(([token]) =>
      [
        'tab-',
        'badge-',
        'card-',
        'toggle-',
        'list-row-',
        'empty-state-',
        'action-button-',
        'search-',
      ].some((prefix) => token.startsWith(prefix)),
    ),
  ) as Record<ComponentThemeToken, string>,
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

function componentToken(componentName: ThemeComponentName, field: string): ComponentThemeToken {
  const prefixMap: Record<ThemeComponentName, string> = {
    dropdown: 'dropdown',
    chip: 'chip',
    iconAction: 'icon-action',
    dock: 'dock',
    formControl: 'form-control',
    tab: 'tab',
    badge: 'badge',
    card: 'card',
    toggle: 'toggle',
    listRow: 'list-row',
    emptyState: 'empty-state',
    actionButton: 'action-button',
    search: 'search',
  };
  const prefix = prefixMap[componentName];
  return `${prefix}-${field}` as ComponentThemeToken;
}

function componentValue<T extends Record<string, string | undefined>, K extends keyof T>(
  component: Partial<T> | undefined,
  field: K,
) {
  return component?.[field];
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

function normalizeStoredComponents(value: unknown): ThemeComponentConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const normalized = Object.fromEntries(
    (Object.keys(THEME_COMPONENT_FIELDS) as ThemeComponentName[]).map((componentName) => {
      const componentValue = record[componentName];
      const componentRecord =
        componentValue && typeof componentValue === 'object' && !Array.isArray(componentValue)
          ? (componentValue as Record<string, unknown>)
          : {};

      const fields = THEME_COMPONENT_FIELDS[componentName] as readonly string[];
      const normalizedComponent = Object.fromEntries(
        fields.flatMap((field) => {
          const normalizedValue = normalizeColorValue(componentRecord[field]);
          if (!normalizedValue) return [];
          return [[field, normalizedValue]];
        }),
      );

      return [componentName, normalizedComponent];
    }),
  ) as ThemeComponentConfig;

  return normalized;
}

function createDefaultComponentSemanticTokens(
  base: Record<BaseSemanticThemeToken, string>,
): Record<ComponentThemeToken, string> {
  const defaults = {} as Record<ComponentThemeToken, string>;

  function assignComponent(
    componentName: ThemeComponentName,
    values: Partial<Record<string, BaseSemanticThemeToken>>,
  ) {
    const prefixMap: Record<ThemeComponentName, ComponentThemeTokenPrefix> = {
      dropdown: 'dropdown',
      chip: 'chip',
      iconAction: 'icon-action',
      dock: 'dock',
      formControl: 'form-control',
      tab: 'tab',
      badge: 'badge',
      card: 'card',
      toggle: 'toggle',
      listRow: 'list-row',
      emptyState: 'empty-state',
      actionButton: 'action-button',
      search: 'search',
    };
    const fields = COMPONENT_THEME_TOKEN_FIELDS[prefixMap[componentName]];
    for (const field of fields) {
      const token = values[field];
      if (!token) continue;
      defaults[componentToken(componentName, field)] = base[token];
    }
  }

  assignComponent('dropdown', {
    bg: 'surface-panel-elevated',
    border: 'border-default',
    text: 'text-primary',
    'text-muted': 'text-muted',
    'control-bg': 'surface-panel-muted',
    'hover-bg': 'surface-panel-hover',
    'active-bg': 'surface-panel-active',
    accent: 'border-accent',
    shadow: 'shadow-panel',
  });
  assignComponent('chip', {
    'border-neutral': 'border-muted',
    'border-subtle': 'border-muted',
    'bg-neutral': 'surface-chip',
    'bg-hover': 'surface-chip-hover',
    'fg-neutral': 'text-primary',
  });
  assignComponent('iconAction', {
    border: 'border-default',
    bg: 'surface-panel-muted',
    'bg-hover': 'surface-panel-hover',
  });
  assignComponent('dock', {
    'tray-bg': 'surface-dock',
    'tray-border': 'border-muted',
    'tray-shadow': 'shadow-glow',
    thumb: 'border-muted',
    'chip-bg': 'surface-dock',
    'chip-hover-bg': 'surface-dock-hover',
    'chip-border': 'border-muted',
    'chip-text': 'text-primary',
    handle: 'border-muted',
    'handle-hover': 'text-secondary',
    'handle-shadow': 'shadow-glow',
  });
  assignComponent('formControl', {
    bg: 'surface-panel-muted',
    border: 'border-default',
    text: 'text-primary',
    placeholder: 'text-muted',
    'focus-border': 'border-strong',
    'focus-ring': 'accent-soft',
    'button-bg': 'surface-panel-muted',
    'button-border': 'border-default',
    'button-text': 'text-primary',
    'button-hover-bg': 'surface-panel-hover',
    'button-primary-bg': 'accent-strong',
    'button-primary-border': 'accent-primary',
    'button-primary-text': 'text-inverse',
    'button-primary-hover-bg': 'accent-primary',
  });
  assignComponent('tab', {
    bg: 'surface-panel-muted',
    border: 'border-muted',
    text: 'text-muted',
    'hover-bg': 'surface-panel-hover',
    'active-bg': 'surface-panel-active',
    'active-border': 'border-accent',
    'active-text': 'text-primary',
  });
  assignComponent('badge', {
    bg: 'surface-chip',
    border: 'border-muted',
    text: 'text-secondary',
    'accent-bg': 'accent-soft',
    'accent-border': 'border-accent',
    'accent-text': 'text-info',
  });
  assignComponent('card', {
    bg: 'surface-panel-muted',
    border: 'border-muted',
    shadow: 'shadow-panel',
    'hover-bg': 'surface-panel-hover',
    'active-bg': 'surface-panel-active',
  });
  assignComponent('toggle', {
    track: 'border-default',
    'track-border': 'border-muted',
    thumb: 'status-neutral',
    'active-track': 'accent-primary',
    'active-thumb': 'text-inverse',
  });
  assignComponent('listRow', {
    bg: 'surface-panel-muted',
    border: 'border-muted',
    text: 'text-primary',
    'text-muted': 'text-muted',
    'hover-bg': 'surface-panel-hover',
    'active-bg': 'surface-panel-active',
  });
  assignComponent('emptyState', {
    bg: 'surface-panel-muted',
    text: 'text-muted',
    'text-muted': 'text-muted',
    icon: 'text-muted',
  });
  assignComponent('actionButton', {
    bg: 'surface-panel-muted',
    border: 'border-default',
    text: 'text-primary',
    'hover-bg': 'surface-panel-hover',
    'accent-bg': 'accent-soft',
    'accent-border': 'border-accent',
    'accent-text': 'text-primary',
  });
  assignComponent('search', {
    bg: 'surface-panel-muted',
    border: 'border-default',
    text: 'text-primary',
    placeholder: 'text-muted',
    icon: 'text-muted',
    'focus-bg': 'accent-soft',
  });

  return defaults;
}

function cloneRegionThemeRegions(
  regions: Record<RegionName, Partial<RegionColors>>,
): Record<RegionName, Partial<RegionColors>> {
  return Object.fromEntries(
    REGION_NAMES.map((regionName) => [regionName, { ...regions[regionName] }]),
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
  const dropdownComponent = theme.components?.dropdown;
  const chipComponent = theme.components?.chip;
  const iconActionComponent = theme.components?.iconAction;
  const dockComponent = theme.components?.dock;
  const formControlComponent = theme.components?.formControl;
  const tabComponent = theme.components?.tab;
  const badgeComponent = theme.components?.badge;
  const cardComponent = theme.components?.card;
  const toggleComponent = theme.components?.toggle;
  const listRowComponent = theme.components?.listRow;
  const emptyStateComponent = theme.components?.emptyState;
  const actionButtonComponent = theme.components?.actionButton;
  const searchComponent = theme.components?.search;
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
    'dropdown-bg': firstDefined(componentValue(dropdownComponent, 'bg'), regionColorValue(dropdown, 'bg'), regionColorValue(modal, 'bg')),
    'dropdown-border': firstDefined(componentValue(dropdownComponent, 'border'), regionColorValue(dropdown, 'border'), regionColorValue(modal, 'border')),
    'dropdown-text': firstDefined(componentValue(dropdownComponent, 'text'), regionColorValue(dropdown, 'text'), regionColorValue(modal, 'text')),
    'dropdown-text-muted': firstDefined(componentValue(dropdownComponent, 'textMuted'), regionColorValue(dropdown, 'textMuted'), regionColorValue(modal, 'textMuted')),
    'dropdown-control-bg': firstDefined(componentValue(dropdownComponent, 'controlBg'), regionColorValue(dropdown, 'controlBg'), regionColorValue(modal, 'controlBg')),
    'dropdown-hover-bg': firstDefined(componentValue(dropdownComponent, 'hoverBg'), regionColorValue(dropdown, 'controlBg'), regionColorValue(side, 'controlBg')),
    'dropdown-active-bg': firstDefined(componentValue(dropdownComponent, 'activeBg'), regionColorValue(dropdown, 'activeBg'), regionColorValue(modal, 'activeBg')),
    'dropdown-accent': firstDefined(componentValue(dropdownComponent, 'accent'), regionColorValue(dropdown, 'accent'), regionColorValue(modal, 'accent')),
    'dropdown-shadow': firstDefined(componentValue(dropdownComponent, 'shadow'), DEFAULT_BASE_SEMANTIC_TOKENS['shadow-panel']),
    'chip-border-neutral': firstDefined(componentValue(chipComponent, 'borderNeutral'), regionColorValue(chat, 'border'), regionColorValue(modal, 'border'), regionColorValue(side, 'border')),
    'chip-border-subtle': firstDefined(componentValue(chipComponent, 'borderSubtle')),
    'chip-bg-neutral': firstDefined(componentValue(chipComponent, 'bgNeutral'), regionColorValue(chat, 'controlBg'), regionColorValue(side, 'controlBg'), regionColorValue(top, 'controlBg')),
    'chip-bg-hover': firstDefined(componentValue(chipComponent, 'bgHover'), regionColorValue(chat, 'activeBg'), regionColorValue(side, 'activeBg'), regionColorValue(top, 'activeBg')),
    'chip-fg-neutral': firstDefined(componentValue(chipComponent, 'fgNeutral'), regionColorValue(chat, 'text'), regionColorValue(modal, 'text'), regionColorValue(side, 'text')),
    'icon-action-border': firstDefined(componentValue(iconActionComponent, 'border'), regionColorValue(dropdown, 'border'), regionColorValue(top, 'border')),
    'icon-action-bg': firstDefined(componentValue(iconActionComponent, 'bg'), regionColorValue(dropdown, 'controlBg'), regionColorValue(top, 'controlBg')),
    'icon-action-bg-hover': firstDefined(componentValue(iconActionComponent, 'bgHover'), regionColorValue(dropdown, 'activeBg'), regionColorValue(top, 'activeBg')),
    'dock-tray-bg': firstDefined(componentValue(dockComponent, 'trayBg'), regionColorValue(page, 'controlBg'), regionColorValue(page, 'bg')),
    'dock-tray-border': firstDefined(componentValue(dockComponent, 'trayBorder'), regionColorValue(page, 'border')),
    'dock-tray-shadow': firstDefined(componentValue(dockComponent, 'trayShadow'), DEFAULT_BASE_SEMANTIC_TOKENS['shadow-glow']),
    'dock-thumb': firstDefined(componentValue(dockComponent, 'thumb'), regionColorValue(page, 'textMuted'), regionColorValue(page, 'border')),
    'dock-chip-bg': firstDefined(componentValue(dockComponent, 'chipBg'), regionColorValue(page, 'controlBg'), regionColorValue(page, 'bg')),
    'dock-chip-hover-bg': firstDefined(componentValue(dockComponent, 'chipHoverBg'), regionColorValue(page, 'activeBg'), regionColorValue(page, 'controlBg')),
    'dock-chip-border': firstDefined(componentValue(dockComponent, 'chipBorder'), regionColorValue(page, 'border')),
    'dock-chip-text': firstDefined(componentValue(dockComponent, 'chipText'), regionColorValue(page, 'text'), regionColorValue(top, 'text')),
    'dock-handle': firstDefined(componentValue(dockComponent, 'handle'), regionColorValue(page, 'textMuted'), regionColorValue(page, 'border')),
    'dock-handle-hover': firstDefined(componentValue(dockComponent, 'handleHover'), regionColorValue(page, 'text'), regionColorValue(top, 'text')),
    'dock-handle-shadow': firstDefined(componentValue(dockComponent, 'handleShadow'), DEFAULT_BASE_SEMANTIC_TOKENS['shadow-glow']),
    'form-control-bg': firstDefined(componentValue(formControlComponent, 'bg'), regionColorValue(input, 'controlBg'), regionColorValue(modal, 'controlBg')),
    'form-control-border': firstDefined(componentValue(formControlComponent, 'border'), regionColorValue(input, 'border'), regionColorValue(modal, 'border')),
    'form-control-text': firstDefined(componentValue(formControlComponent, 'text'), regionColorValue(input, 'text'), regionColorValue(modal, 'text')),
    'form-control-placeholder': firstDefined(componentValue(formControlComponent, 'placeholder'), regionColorValue(input, 'textMuted'), regionColorValue(modal, 'textMuted')),
    'form-control-focus-border': firstDefined(componentValue(formControlComponent, 'focusBorder'), regionColorValue(input, 'accent'), regionColorValue(modal, 'accent')),
    'form-control-focus-ring': firstDefined(componentValue(formControlComponent, 'focusRing'), `color-mix(in srgb, ${firstDefined(regionColorValue(input, 'accent'), regionColorValue(modal, 'accent'), DEFAULT_BASE_SEMANTIC_TOKENS['accent-primary'])} 35%, transparent)`),
    'form-button-bg': firstDefined(componentValue(formControlComponent, 'buttonBg'), regionColorValue(modal, 'controlBg'), regionColorValue(input, 'controlBg')),
    'form-button-border': firstDefined(componentValue(formControlComponent, 'buttonBorder'), regionColorValue(modal, 'border'), regionColorValue(input, 'border')),
    'form-button-text': firstDefined(componentValue(formControlComponent, 'buttonText'), regionColorValue(modal, 'text'), regionColorValue(input, 'text')),
    'form-button-hover-bg': firstDefined(componentValue(formControlComponent, 'buttonHoverBg'), regionColorValue(modal, 'activeBg'), regionColorValue(input, 'activeBg')),
    'form-button-primary-bg': firstDefined(componentValue(formControlComponent, 'buttonPrimaryBg'), DEFAULT_BASE_SEMANTIC_TOKENS['accent-strong']),
    'form-button-primary-border': firstDefined(componentValue(formControlComponent, 'buttonPrimaryBorder'), firstDefined(regionColorValue(modal, 'accent'), regionColorValue(input, 'accent'))),
    'form-button-primary-text': firstDefined(componentValue(formControlComponent, 'buttonPrimaryText'), firstDefined(regionColorValue(modal, 'activeText'), regionColorValue(input, 'activeText'))),
    'form-button-primary-hover-bg': firstDefined(componentValue(formControlComponent, 'buttonPrimaryHoverBg'), firstDefined(regionColorValue(modal, 'accent'), regionColorValue(input, 'accent'))),
    'tab-bg': firstDefined(componentValue(tabComponent, 'bg'), regionColorValue(modal, 'controlBg'), regionColorValue(side, 'bg')),
    'tab-border': firstDefined(componentValue(tabComponent, 'border'), regionColorValue(modal, 'border'), regionColorValue(side, 'border')),
    'tab-text': firstDefined(componentValue(tabComponent, 'text'), regionColorValue(modal, 'textMuted'), regionColorValue(side, 'text')),
    'tab-hover-bg': firstDefined(componentValue(tabComponent, 'hoverBg'), regionColorValue(modal, 'activeBg'), regionColorValue(side, 'controlBg')),
    'tab-active-bg': firstDefined(componentValue(tabComponent, 'activeBg'), regionColorValue(modal, 'activeBg'), regionColorValue(side, 'activeBg')),
    'tab-active-border': firstDefined(componentValue(tabComponent, 'activeBorder'), regionColorValue(modal, 'accent'), regionColorValue(side, 'accent')),
    'tab-active-text': firstDefined(componentValue(tabComponent, 'activeText'), regionColorValue(modal, 'activeText'), regionColorValue(side, 'activeText'), regionColorValue(modal, 'text'), regionColorValue(side, 'text')),
    'badge-bg': firstDefined(componentValue(badgeComponent, 'bg'), regionColorValue(chat, 'controlBg'), regionColorValue(modal, 'controlBg'), regionColorValue(side, 'controlBg')),
    'badge-border': firstDefined(componentValue(badgeComponent, 'border'), regionColorValue(chat, 'border'), regionColorValue(modal, 'border'), regionColorValue(side, 'border')),
    'badge-text': firstDefined(componentValue(badgeComponent, 'text'), regionColorValue(chat, 'textMuted'), regionColorValue(modal, 'text'), regionColorValue(side, 'textMuted')),
    'badge-accent-bg': firstDefined(componentValue(badgeComponent, 'accentBg'), regionColorValue(side, 'activeBg'), regionColorValue(modal, 'activeBg')),
    'badge-accent-border': firstDefined(componentValue(badgeComponent, 'accentBorder'), regionColorValue(side, 'accent'), regionColorValue(modal, 'accent')),
    'badge-accent-text': firstDefined(componentValue(badgeComponent, 'accentText'), regionColorValue(side, 'activeText'), regionColorValue(modal, 'activeText'), regionColorValue(side, 'text')),
    'card-bg': firstDefined(componentValue(cardComponent, 'bg'), regionColorValue(modal, 'controlBg'), regionColorValue(side, 'controlBg'), regionColorValue(output, 'controlBg')),
    'card-border': firstDefined(componentValue(cardComponent, 'border'), regionColorValue(modal, 'border'), regionColorValue(side, 'border'), regionColorValue(output, 'border')),
    'card-shadow': firstDefined(componentValue(cardComponent, 'shadow'), DEFAULT_BASE_SEMANTIC_TOKENS['shadow-panel']),
    'card-hover-bg': firstDefined(componentValue(cardComponent, 'hoverBg'), regionColorValue(modal, 'activeBg'), regionColorValue(side, 'activeBg')),
    'card-active-bg': firstDefined(componentValue(cardComponent, 'activeBg'), regionColorValue(side, 'activeBg'), regionColorValue(modal, 'activeBg')),
    'toggle-track': firstDefined(componentValue(toggleComponent, 'track'), regionColorValue(modal, 'border'), regionColorValue(side, 'border')),
    'toggle-track-border': firstDefined(componentValue(toggleComponent, 'trackBorder'), regionColorValue(modal, 'border'), regionColorValue(side, 'border')),
    'toggle-thumb': firstDefined(componentValue(toggleComponent, 'thumb'), regionColorValue(modal, 'textMuted'), regionColorValue(side, 'textMuted')),
    'toggle-active-track': firstDefined(componentValue(toggleComponent, 'activeTrack'), regionColorValue(modal, 'accent'), regionColorValue(side, 'accent')),
    'toggle-active-thumb': firstDefined(componentValue(toggleComponent, 'activeThumb'), regionColorValue(modal, 'activeText'), regionColorValue(side, 'activeText')),
    'list-row-bg': firstDefined(componentValue(listRowComponent, 'bg'), regionColorValue(modal, 'controlBg'), regionColorValue(side, 'controlBg'), regionColorValue(output, 'controlBg')),
    'list-row-border': firstDefined(componentValue(listRowComponent, 'border'), regionColorValue(modal, 'border'), regionColorValue(side, 'border'), regionColorValue(output, 'border')),
    'list-row-text': firstDefined(componentValue(listRowComponent, 'text'), regionColorValue(modal, 'text'), regionColorValue(side, 'text'), regionColorValue(output, 'text')),
    'list-row-text-muted': firstDefined(componentValue(listRowComponent, 'textMuted'), regionColorValue(modal, 'textMuted'), regionColorValue(side, 'textMuted'), regionColorValue(output, 'textMuted')),
    'list-row-hover-bg': firstDefined(componentValue(listRowComponent, 'hoverBg'), regionColorValue(modal, 'activeBg'), regionColorValue(side, 'activeBg'), regionColorValue(output, 'activeBg')),
    'list-row-active-bg': firstDefined(componentValue(listRowComponent, 'activeBg'), regionColorValue(modal, 'activeBg'), regionColorValue(side, 'activeBg'), regionColorValue(output, 'activeBg')),
    'empty-state-bg': firstDefined(componentValue(emptyStateComponent, 'bg'), regionColorValue(modal, 'controlBg'), regionColorValue(side, 'controlBg')),
    'empty-state-text': firstDefined(componentValue(emptyStateComponent, 'text'), regionColorValue(modal, 'textMuted'), regionColorValue(side, 'textMuted'), regionColorValue(output, 'textMuted')),
    'empty-state-text-muted': firstDefined(componentValue(emptyStateComponent, 'textMuted'), regionColorValue(modal, 'textMuted'), regionColorValue(side, 'textMuted'), regionColorValue(output, 'textMuted')),
    'empty-state-icon': firstDefined(componentValue(emptyStateComponent, 'icon'), regionColorValue(modal, 'textMuted'), regionColorValue(side, 'textMuted')),
    'action-button-bg': firstDefined(componentValue(actionButtonComponent, 'bg'), regionColorValue(modal, 'controlBg'), regionColorValue(dropdown, 'controlBg')),
    'action-button-border': firstDefined(componentValue(actionButtonComponent, 'border'), regionColorValue(modal, 'border'), regionColorValue(dropdown, 'border')),
    'action-button-text': firstDefined(componentValue(actionButtonComponent, 'text'), regionColorValue(modal, 'text'), regionColorValue(dropdown, 'text')),
    'action-button-hover-bg': firstDefined(componentValue(actionButtonComponent, 'hoverBg'), regionColorValue(modal, 'activeBg'), regionColorValue(dropdown, 'activeBg')),
    'action-button-accent-bg': firstDefined(componentValue(actionButtonComponent, 'accentBg'), regionColorValue(modal, 'activeBg'), regionColorValue(dropdown, 'activeBg')),
    'action-button-accent-border': firstDefined(componentValue(actionButtonComponent, 'accentBorder'), regionColorValue(modal, 'accent'), regionColorValue(dropdown, 'accent')),
    'action-button-accent-text': firstDefined(componentValue(actionButtonComponent, 'accentText'), regionColorValue(modal, 'activeText'), regionColorValue(dropdown, 'text'), regionColorValue(modal, 'text')),
    'search-bg': firstDefined(componentValue(searchComponent, 'bg'), regionColorValue(dropdown, 'bg'), regionColorValue(modal, 'controlBg'), regionColorValue(input, 'controlBg')),
    'search-border': firstDefined(componentValue(searchComponent, 'border'), regionColorValue(dropdown, 'border'), regionColorValue(modal, 'border'), regionColorValue(input, 'border')),
    'search-text': firstDefined(componentValue(searchComponent, 'text'), regionColorValue(dropdown, 'text'), regionColorValue(modal, 'text'), regionColorValue(input, 'text')),
    'search-placeholder': firstDefined(componentValue(searchComponent, 'placeholder'), regionColorValue(dropdown, 'textMuted'), regionColorValue(modal, 'textMuted'), regionColorValue(input, 'textMuted')),
    'search-icon': firstDefined(componentValue(searchComponent, 'icon'), regionColorValue(dropdown, 'textMuted'), regionColorValue(modal, 'textMuted'), regionColorValue(input, 'textMuted')),
    'search-focus-bg': firstDefined(componentValue(searchComponent, 'focusBg'), regionColorValue(dropdown, 'activeBg'), regionColorValue(modal, 'activeBg'), regionColorValue(input, 'activeBg')),
  };

  if (!overrides['chip-border-subtle']) {
    const baseBorder = firstDefined(overrides['chip-border-neutral'], overrides['border-muted']);
    if (baseBorder) {
      overrides['chip-border-subtle'] = `color-mix(in srgb, ${baseBorder} 80%, transparent)`;
    }
  }

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
    components: normalizeStoredComponents(input.components),
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
  const componentOverrides = Object.fromEntries(
    (Object.keys(THEME_COMPONENT_FIELDS) as ThemeComponentName[]).flatMap((componentName) => {
      const component = theme.components?.[componentName];
      const fieldMap = COMPONENT_THEME_TOKEN_MAP[componentName] as Record<string, BaseSemanticThemeToken>;
      return Object.entries(fieldMap).flatMap(([field, token]) => {
        const value = normalizeColorValue((component as Record<string, unknown> | undefined)?.[field]);
        if (!value) return [];
        return [[token, value]];
      });
    }),
  ) as SemanticTokenOverrides;

  return {
    version: 2,
    preset: normalizeThemeRegistryId(theme.name),
    label: theme.label,
    regions: cloneRegionThemeRegions(theme.regions),
    components: cloneThemeComponents(theme.components),
    overrides: {
      ...semanticOverrides,
      ...regionOverrides,
      ...componentOverrides,
    },
  };
}

export function storageToRegionTheme(storage: ThemeStorageV2 | null | undefined): RegionThemeConfig | null {
  if (!storage) return null;

  const preset = resolveThemeRegistryTheme(storage.preset ?? null);
  const normalizedRegions = storage.regions ? cloneRegionThemeRegions(storage.regions) : undefined;
  const normalizedComponents = storage.components ? cloneThemeComponents(storage.components) : undefined;

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
        components: normalizedComponents,
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
        components: normalizedComponents,
    };
  }

  if (preset) {
    return {
      name: preset.name,
      label: preset.label,
      regions: cloneRegionThemeRegions(preset.regions),
      components: cloneThemeComponents(preset.components),
    };
  }

  return {
    name: storage.preset ?? 'custom',
    label: storage.label ?? 'Custom',
    regions: cloneRegionThemeRegions(DEFAULT_REGION_THEME.regions),
    components: normalizedComponents,
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
