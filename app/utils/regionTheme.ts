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

export const OCEAN_PRESET: RegionThemeConfig = {
  name: 'ocean',
  label: '深海',
  regions: {
    topPanel: {
      bg: '#1a1a2e',
      text: '#eaf6ff',
      border: '#274c77',
      accent: '#4cc9f0',
      controlBg: '#16213e',
      activeBg: '#0f3460',
      activeText: '#ffffff',
      textMuted: '#7aa2c0',
    },
    sidePanel: {
      bg: '#102542',
      text: '#d9f0ff',
      border: '#1f4e79',
      accent: '#2ec4ff',
      controlBg: '#16324f',
      activeBg: '#1b4965',
      activeText: '#ffffff',
      textMuted: '#7aa2c0',
    },
    inputPanel: {
      bg: '#0b1f33',
      text: '#edf7ff',
      border: '#1f5f8b',
      accent: '#56cfe1',
      controlBg: '#12324a',
      activeBg: '#155e75',
      activeText: '#f7feff',
      textMuted: '#7aa2c0',
    },
    outputPanel: {
      bg: '#13293d',
      text: '#e0f4ff',
      border: '#1b5c85',
      accent: '#76e4f7',
      controlBg: '#1b3a4b',
      activeBg: '#006494',
      activeText: '#ffffff',
      textMuted: '#7aa2c0',
    },
    topDropdown: {
      bg: '#0b1f33',
      text: '#edf7ff',
      border: '#1f5f8b',
      accent: '#56cfe1',
      controlBg: '#12324a',
      activeBg: '#155e75',
      activeText: '#f7feff',
      textMuted: '#7aa2c0',
    },
    modalPanel: {
      bg: '#13293d',
      text: '#e0f4ff',
      border: '#1b5c85',
      accent: '#76e4f7',
      controlBg: '#1b3a4b',
      activeBg: '#006494',
      activeText: '#ffffff',
      textMuted: '#7aa2c0',
    },
    loginScreen: {
      bg: '#0f2033',
      text: '#eaf6ff',
      border: '#29506f',
      accent: '#4cc9f0',
      controlBg: '#13283f',
      activeBg: '#1d4f73',
      activeText: '#ffffff',
      textMuted: '#8fb8d0',
    },
    pageBackground: {
      bg: '#b8c9d8',
      text: '#eaf6ff',
      border: '#274c77',
      accent: '#4cc9f0',
      controlBg: '#97b1c8',
      activeBg: '#6f94b9',
      activeText: '#ffffff',
      textMuted: '#7aa2c0',
    },
    chatCard: {
      bg: '#0a192db8',
      text: '#e0f4ff',
      border: '#1b5c85',
      accent: '#76e4f7',
      controlBg: '#1b3a4b',
      activeBg: '#006494',
      activeText: '#ffffff',
      textMuted: '#7aa2c0',
    },
  },
  floating: {
    surfaceBase: '#09192a',
    surfaceMuted: '#0f2842',
    surfaceSubtle: '#0e2237',
    surfaceStrong: '#164e6e',
    borderMuted: 'rgba(118, 228, 247, 0.34)',
    borderSubtle: 'rgba(138, 230, 246, 0.46)',
    borderFaint: 'rgba(234, 246, 255, 0.16)',
    borderFaintStrong: 'rgba(234, 246, 255, 0.24)',
    fillFaint: 'rgba(118, 228, 247, 0.12)',
    text: '#edf7ff',
    textMuted: '#9ed2e7',
    textSoft: '#87b8cb',
    textSecondary: '#d9f0ff',
    backgroundImage: 'radial-gradient(circle at top right, rgba(118, 228, 247, 0.22), transparent 38%), linear-gradient(135deg, rgba(7, 18, 34, 0.18), rgba(12, 42, 68, 0.28))',
     default: {
       accent: '#76e4f7',
       opacity: '0.92',
       titlebarOpacity: '1',
       backgroundImage: 'radial-gradient(circle at top right, rgba(118, 228, 247, 0.22), transparent 38%), linear-gradient(135deg, rgba(7, 18, 34, 0.18), rgba(12, 42, 68, 0.28))',
     },
    shell: { accent: '#67d7ff', backgroundImage: 'linear-gradient(135deg, rgba(6, 20, 40, 0.18), rgba(18, 54, 84, 0.3))' },
    reasoning: { accent: '#a78bfa', backgroundImage: 'radial-gradient(circle at top left, rgba(167, 139, 250, 0.18), transparent 34%), linear-gradient(135deg, rgba(10, 18, 40, 0.2), rgba(22, 40, 76, 0.26))' },
    subagent: { accent: '#38bdf8', backgroundImage: 'radial-gradient(circle at top right, rgba(56, 189, 248, 0.16), transparent 34%), linear-gradient(135deg, rgba(7, 22, 38, 0.18), rgba(12, 44, 70, 0.28))' },
    tool: { accent: '#5eead4'},
    file: { accent: '#76e4f7' },
    diff: { accent: '#60a5fa' },
    media: { accent: '#2dd4bf', backgroundImage: 'radial-gradient(circle at center, rgba(45, 212, 191, 0.16), transparent 42%), linear-gradient(135deg, rgba(8, 25, 34, 0.16), rgba(14, 54, 62, 0.26))' },
    dialog: { accent: '#fbbf24' },
    history: { accent: '#c084fc' },
    debug: { accent: '#94a3b8' },
  },
};

export const FOREST_PRESET: RegionThemeConfig = {
  name: 'forest',
  label: '林境',
  regions: {
    topPanel: {
      bg: '#1b2f24',
      text: '#edf7ee',
      border: '#355e3b',
      accent: '#7fb069',
      controlBg: '#243b2f',
      activeBg: '#3a5a40',
      activeText: '#ffffff',
      textMuted: '#7d9e7d',
    },
    sidePanel: {
      bg: '#14281d',
      text: '#e7f5ea',
      border: '#2d4739',
      accent: '#90be6d',
      controlBg: '#1d3528',
      activeBg: '#31572c',
      activeText: '#f9fff9',
      textMuted: '#7d9e7d',
    },
    inputPanel: {
      bg: '#1f3525',
      text: '#f0faf2',
      border: '#406343',
      accent: '#a7c957',
      controlBg: '#29432f',
      activeBg: '#4f772d',
      activeText: '#ffffff',
      textMuted: '#7d9e7d',
    },
    outputPanel: {
      bg: '#233d2b',
      text: '#edf8ef',
      border: '#4c6f49',
      accent: '#84a98c',
      controlBg: '#2c4a36',
      activeBg: '#588157',
      activeText: '#ffffff',
      textMuted: '#7d9e7d',
    },
    topDropdown: {
      bg: '#1f3525',
      text: '#f0faf2',
      border: '#406343',
      accent: '#a7c957',
      controlBg: '#29432f',
      activeBg: '#4f772d',
      activeText: '#ffffff',
      textMuted: '#7d9e7d',
    },
    modalPanel: {
      bg: '#233d2b',
      text: '#edf8ef',
      border: '#4c6f49',
      accent: '#84a98c',
      controlBg: '#2c4a36',
      activeBg: '#588157',
      activeText: '#ffffff',
      textMuted: '#7d9e7d',
    },
    loginScreen: {
      bg: '#29432f',
      text: '#edf7ee',
      border: '#4c6f49',
      accent: '#a7c957',
      controlBg: '#35523d',
      activeBg: '#4f772d',
      activeText: '#ffffff',
      textMuted: '#9cb49c',
    },
    pageBackground: {
      bg: '#bcc8b8',
      text: '#edf7ee',
      border: '#355e3b',
      accent: '#7fb069',
      controlBg: '#a1b19d',
      activeBg: '#7d9179',
      activeText: '#ffffff',
      textMuted: '#7d9e7d',
    },
    chatCard: {
      bg: '#0c1e12b8',
      text: '#edf8ef',
      border: '#4c6f49',
      accent: '#84a98c',
      controlBg: '#2c4a36',
      activeBg: '#588157',
      activeText: '#ffffff',
      textMuted: '#7d9e7d',
    },
  },
  floating: {
    surfaceBase: 'rgba(13, 28, 19, 1)',
    surfaceMuted: 'rgba(24, 52, 37, 1)',
    surfaceSubtle: 'rgba(22, 45, 33, 1)',
    surfaceStrong: 'rgba(56, 105, 71, 1)',
    borderMuted: 'rgba(132, 169, 140, 0.34)',
    borderSubtle: 'rgba(167, 201, 87, 0.42)',
    borderFaint: 'rgba(237, 247, 238, 0.16)',
    borderFaintStrong: 'rgba(237, 247, 238, 0.24)',
    fillFaint: 'rgba(127, 176, 105, 0.12)',
    text: '#f1fbf3',
    textMuted: '#b6d0b4',
    textSoft: '#9ab49a',
    textSecondary: '#e7f5ea',
    backgroundImage: 'radial-gradient(circle at top right, rgba(167, 201, 87, 0.18), transparent 40%), linear-gradient(135deg, rgba(10, 22, 14, 0.16), rgba(25, 53, 35, 0.28))',
    default: {
      accent: '#84a98c',
      opacity: '0.9',
      titlebarOpacity: '0.95',
      backgroundImage: 'radial-gradient(circle at top right, rgba(167, 201, 87, 0.18), transparent 40%), linear-gradient(135deg, rgba(10, 22, 14, 0.16), rgba(25, 53, 35, 0.28))',
    },
    shell: { accent: '#90be6d', backgroundImage: 'linear-gradient(135deg, rgba(11, 27, 16, 0.14), rgba(35, 66, 40, 0.3))' },
    reasoning: { accent: '#c4b5fd', backgroundImage: 'radial-gradient(circle at top left, rgba(196, 181, 253, 0.16), transparent 34%), linear-gradient(135deg, rgba(15, 24, 18, 0.18), rgba(30, 54, 36, 0.24))' },
    subagent: { accent: '#7dd3fc', backgroundImage: 'radial-gradient(circle at top right, rgba(125, 211, 252, 0.14), transparent 34%), linear-gradient(135deg, rgba(10, 24, 18, 0.16), rgba(26, 56, 40, 0.28))' },
    tool: { accent: '#84cc16' },
    file: { accent: '#84a98c' },
    diff: { accent: '#a7c957' },
    media: { accent: '#5eead4', backgroundImage: 'radial-gradient(circle at center, rgba(94, 234, 212, 0.14), transparent 42%), linear-gradient(135deg, rgba(10, 24, 20, 0.16), rgba(28, 62, 44, 0.24))' },
    dialog: { accent: '#facc15' },
    history: { accent: '#bbf7d0' },
    debug: { accent: '#cbd5e1' },
  },
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
      bg: 'rgba(98, 72, 84, 0.92)',
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
    backgroundImage: 'radial-gradient(circle at top right, rgba(255, 194, 220, 1), transparent 40%), linear-gradient(135deg, rgba(48, 26, 40, 0.16), rgba(94, 56, 78, 0.28))',
    default: {
      accent: '#ffc2dc',
      opacity: '0.8',
      titlebarOpacity: '0.95',
      backgroundImage: 'radial-gradient(circle at top right, rgba(255, 194, 220, 1), transparent 40%), linear-gradient(135deg, rgba(48, 26, 40, 0.16), rgba(94, 56, 78, 0.28))',
    },
    shell: { accent: '#ff9ec8', backgroundImage: 'linear-gradient(135deg, rgba(54, 28, 42, 0.16), rgba(112, 66, 94, 0.3))' },
    reasoning: { accent: '#c4b5fd', backgroundImage: 'radial-gradient(circle at top left, rgba(196, 181, 253, 0.16), transparent 34%), linear-gradient(135deg, rgba(56, 26, 44, 0.18), rgba(98, 60, 84, 0.24))' },
    subagent: { accent: '#7dd3fc', backgroundImage: 'radial-gradient(circle at top right, rgba(125, 211, 252, 0.14), transparent 34%), linear-gradient(135deg, rgba(58, 28, 46, 0.16), rgba(104, 62, 88, 0.28))' },
    tool: { accent: '#f9a8d4' },
    file: { accent: '#ffc2dc' },
    diff: { accent: '#ffb7d5' },
    media: { accent: '#f0abfc', backgroundImage: 'radial-gradient(circle at center, rgba(240, 171, 252, 0.16), transparent 42%), linear-gradient(135deg, rgba(54, 24, 44, 0.14), rgba(96, 54, 82, 0.24))' },
    dialog: { accent: '#fbbf24' },
    history: { accent: '#f5d0fe' },
    debug: { accent: '#fbcfe8' },
  },
};

export const REGION_THEME_PRESETS = {
  default: DEFAULT_REGION_THEME,
  ocean: OCEAN_PRESET,
  forest: FOREST_PRESET,
  sakura: SAKURA_PRESET,
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
