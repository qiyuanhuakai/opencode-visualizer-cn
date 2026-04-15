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

export interface RegionThemeConfig {
  name: string;
  label: string;
  regions: Record<RegionName, Partial<RegionColors>>;
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
