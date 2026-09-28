import auroraTideTheme from './aurora-tide.theme_1.json';
import violetNocturneTheme from './violet-nocturne.theme_1.json';
import animeNightTheme from './anime-night.theme_1.json';
import animeDreamTheme from './anime-dream.theme_1.json';
import amberAtlasTheme from './amber-atlas.theme_1.json';
import softWhiteTheme from './soft-white.theme_1.json';
import lightModeTheme from './light-mode.theme_1.json';

export type RegionName =
  | 'topPanel'
  | 'sidePanel'
  | 'inputPanel'
  | 'outputPanel'
  | 'topDropdown'
  | 'modalPanel'
  | 'loginScreen'
  | 'pageBackground'
  | 'chatCard';

export interface RegionColors {
  bg?: string;
  text?: string;
  border?: string;
  accent?: string;
  controlBg?: string;
  activeBg?: string;
  activeText?: string;
  textMuted?: string;
}

export interface DropdownThemeColors {
  bg?: string;
  border?: string;
  text?: string;
  textMuted?: string;
  controlBg?: string;
  hoverBg?: string;
  activeBg?: string;
  accent?: string;
  shadow?: string;
}

export interface ChipThemeColors {
  borderNeutral?: string;
  borderSubtle?: string;
  bgNeutral?: string;
  bgHover?: string;
  fgNeutral?: string;
}

export interface IconActionThemeColors {
  border?: string;
  bg?: string;
  bgHover?: string;
}

export interface DockThemeColors {
  trayBg?: string;
  trayBorder?: string;
  trayShadow?: string;
  thumb?: string;
  chipBg?: string;
  chipHoverBg?: string;
  chipBorder?: string;
  chipText?: string;
  handle?: string;
  handleHover?: string;
  handleShadow?: string;
}

export interface FormControlThemeColors {
  bg?: string;
  border?: string;
  text?: string;
  placeholder?: string;
  focusBorder?: string;
  focusRing?: string;
  buttonBg?: string;
  buttonBorder?: string;
  buttonText?: string;
  buttonHoverBg?: string;
  buttonPrimaryBg?: string;
  buttonPrimaryBorder?: string;
  buttonPrimaryText?: string;
  buttonPrimaryHoverBg?: string;
}

export interface TabThemeColors {
  bg?: string;
  border?: string;
  text?: string;
  hoverBg?: string;
  activeBg?: string;
  activeBorder?: string;
  activeText?: string;
}

export interface BadgeThemeColors {
  bg?: string;
  border?: string;
  text?: string;
  accentBg?: string;
  accentBorder?: string;
  accentText?: string;
}

export interface CardThemeColors {
  bg?: string;
  border?: string;
  shadow?: string;
  hoverBg?: string;
  activeBg?: string;
}

export interface ToggleThemeColors {
  track?: string;
  trackBorder?: string;
  thumb?: string;
  activeTrack?: string;
  activeThumb?: string;
}

export interface ListRowThemeColors {
  bg?: string;
  border?: string;
  text?: string;
  textMuted?: string;
  hoverBg?: string;
  activeBg?: string;
}

export interface EmptyStateThemeColors {
  bg?: string;
  text?: string;
  textMuted?: string;
  icon?: string;
}

export interface ActionButtonThemeColors {
  bg?: string;
  border?: string;
  text?: string;
  hoverBg?: string;
  accentBg?: string;
  accentBorder?: string;
  accentText?: string;
}

export interface SearchThemeColors {
  bg?: string;
  border?: string;
  text?: string;
  placeholder?: string;
  icon?: string;
  focusBg?: string;
}

export interface FloatingWindowTypeThemeColors {
  accent?: string;
  backgroundColor?: string;
  text?: string;
  textMuted?: string;
  textSoft?: string;
  textSecondary?: string;
  syntaxText?: string;
  opacity?: string;
  titlebarOpacity?: string;
  backgroundImage?: string;
}

export interface FloatingWindowThemeColors {
  surfaceBase?: string;
  surfaceMuted?: string;
  surfaceSubtle?: string;
  surfaceStrong?: string;
  borderMuted?: string;
  borderSubtle?: string;
  borderFaint?: string;
  borderFaintStrong?: string;
  fillFaint?: string;
  text?: string;
  textMuted?: string;
  textSoft?: string;
  textSecondary?: string;
  syntaxText?: string;
  opacity?: string;
  titlebarOpacity?: string;
  backgroundImage?: string;
  default?: Partial<FloatingWindowTypeThemeColors>;
  shell?: Partial<FloatingWindowTypeThemeColors>;
  reasoning?: Partial<FloatingWindowTypeThemeColors>;
  subagent?: Partial<FloatingWindowTypeThemeColors>;
  tool?: Partial<FloatingWindowTypeThemeColors>;
  file?: Partial<FloatingWindowTypeThemeColors>;
  diff?: Partial<FloatingWindowTypeThemeColors>;
  media?: Partial<FloatingWindowTypeThemeColors>;
  dialog?: Partial<FloatingWindowTypeThemeColors>;
  history?: Partial<FloatingWindowTypeThemeColors>;
  debug?: Partial<FloatingWindowTypeThemeColors>;
}

export interface ThemeComponentConfig {
  dropdown?: Partial<DropdownThemeColors>;
  chip?: Partial<ChipThemeColors>;
  iconAction?: Partial<IconActionThemeColors>;
  dock?: Partial<DockThemeColors>;
  formControl?: Partial<FormControlThemeColors>;
  tab?: Partial<TabThemeColors>;
  badge?: Partial<BadgeThemeColors>;
  card?: Partial<CardThemeColors>;
  toggle?: Partial<ToggleThemeColors>;
  listRow?: Partial<ListRowThemeColors>;
  emptyState?: Partial<EmptyStateThemeColors>;
  actionButton?: Partial<ActionButtonThemeColors>;
  search?: Partial<SearchThemeColors>;
}

export type ThemeComponentName = keyof ThemeComponentConfig;

export const THEME_COMPONENT_FIELDS = {
  dropdown: ['bg', 'border', 'text', 'textMuted', 'controlBg', 'hoverBg', 'activeBg', 'accent', 'shadow'],
  chip: ['borderNeutral', 'borderSubtle', 'bgNeutral', 'bgHover', 'fgNeutral'],
  iconAction: ['border', 'bg', 'bgHover'],
  dock: ['trayBg', 'trayBorder', 'trayShadow', 'thumb', 'chipBg', 'chipHoverBg', 'chipBorder', 'chipText', 'handle', 'handleHover', 'handleShadow'],
  formControl: ['bg', 'border', 'text', 'placeholder', 'focusBorder', 'focusRing', 'buttonBg', 'buttonBorder', 'buttonText', 'buttonHoverBg', 'buttonPrimaryBg', 'buttonPrimaryBorder', 'buttonPrimaryText', 'buttonPrimaryHoverBg'],
  tab: ['bg', 'border', 'text', 'hoverBg', 'activeBg', 'activeBorder', 'activeText'],
  badge: ['bg', 'border', 'text', 'accentBg', 'accentBorder', 'accentText'],
  card: ['bg', 'border', 'shadow', 'hoverBg', 'activeBg'],
  toggle: ['track', 'trackBorder', 'thumb', 'activeTrack', 'activeThumb'],
  listRow: ['bg', 'border', 'text', 'textMuted', 'hoverBg', 'activeBg'],
  emptyState: ['bg', 'text', 'textMuted', 'icon'],
  actionButton: ['bg', 'border', 'text', 'hoverBg', 'accentBg', 'accentBorder', 'accentText'],
  search: ['bg', 'border', 'text', 'placeholder', 'icon', 'focusBg'],
} as const;

export interface RegionThemeConfig {
  name: string;
  label: string;
  regions: Record<RegionName, Partial<RegionColors>>;
  components?: ThemeComponentConfig;
  floating?: Partial<FloatingWindowThemeColors>;
}

export const REGION_NAMES: RegionName[] = [
  'topPanel',
  'sidePanel',
  'inputPanel',
  'outputPanel',
  'topDropdown',
  'modalPanel',
  'loginScreen',
  'pageBackground',
  'chatCard',
];

export const REGION_COLOR_FIELDS: (keyof RegionColors)[] = [
  'bg',
  'text',
  'border',
  'accent',
  'controlBg',
  'activeBg',
  'activeText',
  'textMuted',
];

const REGION_SELECTORS: Record<RegionName, string> = {
  topPanel: '.top-panel',
  sidePanel: '.side-panel',
  inputPanel: '.input-panel',
  outputPanel: '.output-panel',
  topDropdown: '.top-center, .tree-menu',
  modalPanel: '.modal, .provider-manager-modal, .status-monitor-popover',
  loginScreen: '.app-loading-view',
  pageBackground: 'html, body, #app',
  chatCard: '.thread-block',
};

export const REGION_VAR_PREFIXES: Record<RegionName, string> = {
  topPanel: 'top',
  sidePanel: 'side',
  inputPanel: 'input',
  outputPanel: 'output',
  topDropdown: 'top-dropdown',
  modalPanel: 'modal',
  loginScreen: 'login',
  pageBackground: 'page',
  chatCard: 'chat',
};

function createEmptyRegionColors(): RegionColors {
  return {
    bg: undefined,
    text: undefined,
    border: undefined,
    accent: undefined,
    controlBg: undefined,
    activeBg: undefined,
    activeText: undefined,
    textMuted: undefined,
  };
}

function toKebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

export const DEFAULT_REGION_THEME: RegionThemeConfig = {
  name: 'default',
  label: 'Default',
  regions: {
    topPanel: createEmptyRegionColors(),
    sidePanel: createEmptyRegionColors(),
    inputPanel: createEmptyRegionColors(),
    outputPanel: createEmptyRegionColors(),
    topDropdown: createEmptyRegionColors(),
    modalPanel: createEmptyRegionColors(),
    loginScreen: createEmptyRegionColors(),
    pageBackground: createEmptyRegionColors(),
    chatCard: createEmptyRegionColors(),
  },
};

export const REGION_THEME_EDITOR_FALLBACKS: Required<RegionColors> = {
  bg: '#1a1a2e',
  text: '#eaf6ff',
  border: '#334155',
  accent: '#4cc9f0',
  controlBg: '#16213e',
  activeBg: '#0f3460',
  activeText: '#ffffff',
  textMuted: '#94a3b8',
};

export const AURORA_TIDE_PRESET: RegionThemeConfig = {
  name: auroraTideTheme.id,
  label: auroraTideTheme.label,
  regions: auroraTideTheme.regions,
  components: auroraTideTheme.components,
  floating: auroraTideTheme.floating,
};

export const VIOLET_NOCTURNE_PRESET: RegionThemeConfig = {
  name: violetNocturneTheme.id,
  label: violetNocturneTheme.label,
  regions: violetNocturneTheme.regions,
  components: violetNocturneTheme.components,
  floating: violetNocturneTheme.floating,
};

export const ANIME_NIGHT_PRESET: RegionThemeConfig = {
  name: animeNightTheme.id,
  label: animeNightTheme.label,
  regions: animeNightTheme.regions,
  components: animeNightTheme.components,
  floating: animeNightTheme.floating,
};

export const ANIME_DREAM_PRESET: RegionThemeConfig = {
  name: animeDreamTheme.id,
  label: animeDreamTheme.label,
  regions: animeDreamTheme.regions,
  components: animeDreamTheme.components,
  floating: animeDreamTheme.floating,
};

export const AMBER_ATLAS_PRESET: RegionThemeConfig = {
  name: amberAtlasTheme.id,
  label: amberAtlasTheme.label,
  regions: amberAtlasTheme.regions,
  components: amberAtlasTheme.components,
  floating: amberAtlasTheme.floating,
};

export const SOFT_WHITE_PRESET: RegionThemeConfig = {
  name: softWhiteTheme.id,
  label: softWhiteTheme.label,
  regions: softWhiteTheme.regions,
  components: softWhiteTheme.components,
  floating: softWhiteTheme.floating,
};

export const LIGHT_MODE_PRESET: RegionThemeConfig = {
  name: lightModeTheme.id,
  label: lightModeTheme.label,
  regions: lightModeTheme.regions,
  components: lightModeTheme.components,
  floating: lightModeTheme.floating,
};

export const SAKURA_PRESET: RegionThemeConfig = {
  name: 'sakura',
  label: '樱粉幻梦',
  regions: {
    topPanel: {
      bg: 'rgba(95, 70, 82, 0.92)',
      text: '#fff5fa',
      border: '#c8a0b0',
      accent: '#ffb7d5',
      controlBg: '#785a66',
      activeBg: 'rgba(200, 150, 170, 0.4)',
      activeText: '#ffffff',
      textMuted: '#d4b8c8',
    },
    sidePanel: {
      bg: 'rgba(88, 64, 76, 0.95)',
      text: '#fff0f7',
      border: '#c098a8',
      accent: '#ff9ec8',
      controlBg: '#70505c',
      activeBg: 'rgba(190, 140, 160, 0.45)',
      activeText: '#ffffff',
      textMuted: '#d4b8c8',
    },
    inputPanel: {
      bg: 'rgba(92, 68, 80, 0.92)',
      text: '#fff8fb',
      border: '#cca0b0',
      accent: '#ffaed0',
      controlBg: '#74545e',
      activeBg: 'rgba(195, 145, 165, 0.4)',
      activeText: '#ffffff',
      textMuted: '#d4b8c8',
    },
    outputPanel: {
      bg: 'rgba(92, 68, 80, 0.92)',
      text: '#fff8fb',
      border: '#cca0b0',
      accent: '#ffc2dc',
      controlBg: '#74545e',
      activeBg: 'rgba(195, 145, 165, 0.4)',
      activeText: '#ffffff',
      textMuted: '#d4b8c8',
    },
    topDropdown: {
      bg: 'rgba(95, 70, 82, 0.92)',
      text: '#fff8fb',
      border: '#cca0b0',
      accent: '#ffb7d5',
      controlBg: '#785a66',
      activeBg: 'rgba(200, 150, 170, 0.4)',
      activeText: '#ffffff',
      textMuted: '#d4b8c8',
    },
    modalPanel: {
      bg: 'rgba(95, 70, 82, 0.92)',
      text: '#fff8fb',
      border: '#cca0b0',
      accent: '#ffc2dc',
      controlBg: '#74545e',
      activeBg: 'rgba(195, 145, 165, 0.4)',
      activeText: '#ffffff',
      textMuted: '#d4b8c8',
    },
    loginScreen: {
      bg: 'rgba(104, 78, 90, 0.92)',
      text: '#fff8fb',
      border: '#cca0b0',
      accent: '#ffb7d5',
      controlBg: '#7f6070',
      activeBg: 'rgba(205, 155, 175, 0.42)',
      activeText: '#ffffff',
      textMuted: '#d4b8c8',
    },
    pageBackground: {
      bg: 'rgba(85, 60, 72, 0.95)',
      text: '#fff5fa',
      border: '#c8a0b0',
      accent: '#ffb7d5',
      controlBg: '#785a66',
      activeBg: 'rgba(200, 150, 170, 0.4)',
      activeText: '#ffffff',
      textMuted: '#d4b8c8',
    },
    chatCard: {
      bg: 'rgba(95, 68, 80, 0.72)',
      text: '#fff8fb',
      border: '#cca0b0',
      accent: '#ffc2dc',
      controlBg: '#74545e',
      activeBg: 'rgba(195, 145, 165, 0.4)',
      activeText: '#ffffff',
      textMuted: '#d4b8c8',
    },
  },
  floating: {
    surfaceBase: 'rgba(56, 35, 49, 1)',
    surfaceMuted: 'rgba(96, 64, 82, 1)',
    surfaceSubtle: 'rgba(88, 58, 76, 1)',
    surfaceStrong: 'rgba(160, 102, 132, 1)',
    borderMuted: 'rgba(255, 194, 220, 0.34)',
    borderSubtle: 'rgba(255, 183, 213, 0.44)',
    borderFaint: 'rgba(255, 245, 250, 0.18)',
    borderFaintStrong: 'rgba(255, 245, 250, 0.26)',
    fillFaint: 'rgba(255, 183, 213, 0.12)',
    text: '#fff8fb',
    textMuted: '#e7bfd1',
    textSoft: '#d8adc0',
    textSecondary: '#fff0f7',
    backgroundImage: 'radial-gradient(circle at top right, rgba(255, 194, 220, 0.16), transparent 40%), linear-gradient(135deg, rgba(48, 26, 40, 0.16), rgba(94, 56, 78, 0.28))',
    default: {
      accent: '#ffc2dc',
      backgroundColor: '#382331',
      opacity: '1',
      titlebarOpacity: '0.95',
      backgroundImage: 'radial-gradient(circle at top right, rgba(255, 194, 220, 0.16), transparent 40%), linear-gradient(135deg, rgba(48, 26, 40, 0.16), rgba(94, 56, 78, 0.28))',
    },
    shell: { accent: '#ff9ec8', backgroundColor: '#5e4052', opacity: '1', backgroundImage: 'linear-gradient(135deg, rgba(54, 28, 42, 0.16), rgba(112, 66, 94, 0.3))' },
    reasoning: { accent: '#c4b5fd', backgroundColor: '#4c3046', backgroundImage: 'radial-gradient(circle at top left, rgba(196, 181, 253, 0.16), transparent 34%), linear-gradient(135deg, rgba(56, 26, 44, 0.18), rgba(98, 60, 84, 0.24))' },
    subagent: { accent: '#7dd3fc', backgroundColor: '#3a354d', backgroundImage: 'radial-gradient(circle at top right, rgba(125, 211, 252, 0.14), transparent 34%), linear-gradient(135deg, rgba(58, 28, 46, 0.16), rgba(104, 62, 88, 0.28))' },
    tool: { accent: '#f9a8d4', backgroundColor: '#432c3e' },
    file: { accent: '#ffc2dc', backgroundColor: '#3c2d3d' },
    diff: { accent: '#ffb7d5', backgroundColor: '#4a2b3d' },
    media: { accent: '#f0abfc', backgroundColor: '#472d48', backgroundImage: 'radial-gradient(circle at center, rgba(240, 171, 252, 0.16), transparent 42%), linear-gradient(135deg, rgba(54, 24, 44, 0.14), rgba(96, 54, 82, 0.24))' },
    dialog: { accent: '#fbbf24', backgroundColor: '#4a343b' },
    history: { accent: '#f5d0fe', backgroundColor: '#432f46' },
    debug: { accent: '#fbcfe8', backgroundColor: '#3c3040' },
  },
};

const REGION_THEME_PRESETS = {
  default: DEFAULT_REGION_THEME,
  'aurora-tide': AURORA_TIDE_PRESET,
  'violet-nocturne': VIOLET_NOCTURNE_PRESET,
  sakura: SAKURA_PRESET,
  'anime-night': ANIME_NIGHT_PRESET,
  'anime-dream': ANIME_DREAM_PRESET,
  'amber-atlas': AMBER_ATLAS_PRESET,
  'soft-white': SOFT_WHITE_PRESET,
  'light-mode': LIGHT_MODE_PRESET,
} as const;

export type RegionThemePresetName = keyof typeof REGION_THEME_PRESETS;

export function resolveRegionThemePresetName(name: string | null | undefined): RegionThemePresetName | null {
  if (!name || !Object.prototype.hasOwnProperty.call(REGION_THEME_PRESETS, name)) {
    return null;
  }

  return name as RegionThemePresetName;
}

export function resolveRegionThemePreset(name: string | null | undefined): RegionThemeConfig | null {
  const presetName = resolveRegionThemePresetName(name);
  if (!presetName) {
    return null;
  }

  return REGION_THEME_PRESETS[presetName];
}

export function generateCSS(theme: RegionThemeConfig | null): string {
  if (!theme) {
    return '';
  }

  return REGION_NAMES.map((regionName) => {
    const declarations = REGION_COLOR_FIELDS.flatMap((field) => {
      const value = theme.regions[regionName]?.[field];

      if (value === undefined) {
        return [];
      }

      const regionPrefix = REGION_VAR_PREFIXES[regionName];
      const cssVariable = `--region-${regionPrefix}-${toKebabCase(field)}`;
      return [`  ${cssVariable}: ${value};`];
    });

    if (declarations.length === 0) {
      return '';
    }

    return `${REGION_SELECTORS[regionName]} {
${declarations.join('\n')}
}`;
  })
    .filter(Boolean)
    .join('\n');
}
