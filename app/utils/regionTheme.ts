export type RegionName =
  | 'topPanel'
  | 'sidePanel'
  | 'inputPanel'
  | 'outputPanel'
  | 'floatingWindow'
  | 'topDropdown'
  | 'modalPanel'
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
}

export interface RegionThemeConfig {
  name: string;
  label: string;
  regions: Record<RegionName, Partial<RegionColors>>;
}

const REGION_NAMES: RegionName[] = [
  'topPanel',
  'sidePanel',
  'inputPanel',
  'outputPanel',
  'floatingWindow',
  'topDropdown',
  'modalPanel',
  'pageBackground',
  'chatCard',
];

const COLOR_FIELDS: (keyof RegionColors)[] = [
  'bg',
  'text',
  'border',
  'accent',
  'controlBg',
  'activeBg',
  'activeText',
];

const REGION_SELECTORS: Record<RegionName, string> = {
  topPanel: '.top-panel',
  sidePanel: '.side-panel',
  inputPanel: '.input-panel',
  outputPanel: '.output-panel',
  floatingWindow: '.floating-window',
  topDropdown: '.top-center, .tree-menu',
  modalPanel: '.modal, .provider-manager-modal, .status-monitor-popover',
  pageBackground: 'html, body, #app',
  chatCard: '.thread-block',
};

const REGION_VAR_PREFIXES: Record<RegionName, string> = {
  topPanel: 'top',
  sidePanel: 'side',
  inputPanel: 'input',
  outputPanel: 'output',
  floatingWindow: 'floating',
  topDropdown: 'top-dropdown',
  modalPanel: 'modal',
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
    floatingWindow: createEmptyRegionColors(),
    topDropdown: createEmptyRegionColors(),
    modalPanel: createEmptyRegionColors(),
    pageBackground: createEmptyRegionColors(),
    chatCard: createEmptyRegionColors(),
  },
};

export const OCEAN_PRESET: RegionThemeConfig = {
  name: 'ocean',
  label: 'Ocean',
  regions: {
    topPanel: {
      bg: '#1a1a2e',
      text: '#eaf6ff',
      border: '#274c77',
      accent: '#4cc9f0',
      controlBg: '#16213e',
      activeBg: '#0f3460',
      activeText: '#ffffff',
    },
    sidePanel: {
      bg: '#102542',
      text: '#d9f0ff',
      border: '#1f4e79',
      accent: '#2ec4ff',
      controlBg: '#16324f',
      activeBg: '#1b4965',
      activeText: '#ffffff',
    },
    inputPanel: {
      bg: '#0b1f33',
      text: '#edf7ff',
      border: '#1f5f8b',
      accent: '#56cfe1',
      controlBg: '#12324a',
      activeBg: '#155e75',
      activeText: '#f7feff',
    },
    outputPanel: {
      bg: '#13293d',
      text: '#e0f4ff',
      border: '#1b5c85',
      accent: '#76e4f7',
      controlBg: '#1b3a4b',
      activeBg: '#006494',
      activeText: '#ffffff',
    },
    floatingWindow: {
      bg: '#1c2541',
      text: '#f1f7ff',
      border: '#3a506b',
      accent: '#5bc0be',
      controlBg: '#273469',
      activeBg: '#0b6e99',
      activeText: '#ffffff',
    },
    topDropdown: {
      bg: '#0b1f33',
      text: '#edf7ff',
      border: '#1f5f8b',
      accent: '#56cfe1',
      controlBg: '#12324a',
      activeBg: '#155e75',
      activeText: '#f7feff',
    },
    modalPanel: {
      bg: '#13293d',
      text: '#e0f4ff',
      border: '#1b5c85',
      accent: '#76e4f7',
      controlBg: '#1b3a4b',
      activeBg: '#006494',
      activeText: '#ffffff',
    },
    pageBackground: {
      bg: '#08101f',
      text: '#eaf6ff',
      border: '#274c77',
      accent: '#4cc9f0',
      controlBg: '#16213e',
      activeBg: '#0f3460',
      activeText: '#ffffff',
    },
    chatCard: {
      bg: '#0a192db8',
      text: '#e0f4ff',
      border: '#1b5c85',
      accent: '#76e4f7',
      controlBg: '#1b3a4b',
      activeBg: '#006494',
      activeText: '#ffffff',
    },
  },
};

export const FOREST_PRESET: RegionThemeConfig = {
  name: 'forest',
  label: 'Forest',
  regions: {
    topPanel: {
      bg: '#1b2f24',
      text: '#edf7ee',
      border: '#355e3b',
      accent: '#7fb069',
      controlBg: '#243b2f',
      activeBg: '#3a5a40',
      activeText: '#ffffff',
    },
    sidePanel: {
      bg: '#14281d',
      text: '#e7f5ea',
      border: '#2d4739',
      accent: '#90be6d',
      controlBg: '#1d3528',
      activeBg: '#31572c',
      activeText: '#f9fff9',
    },
    inputPanel: {
      bg: '#1f3525',
      text: '#f0faf2',
      border: '#406343',
      accent: '#a7c957',
      controlBg: '#29432f',
      activeBg: '#4f772d',
      activeText: '#ffffff',
    },
    outputPanel: {
      bg: '#233d2b',
      text: '#edf8ef',
      border: '#4c6f49',
      accent: '#84a98c',
      controlBg: '#2c4a36',
      activeBg: '#588157',
      activeText: '#ffffff',
    },
    floatingWindow: {
      bg: '#2f3e2f',
      text: '#f4fbf4',
      border: '#52796f',
      accent: '#cad2c5',
      controlBg: '#354f38',
      activeBg: '#52734d',
      activeText: '#ffffff',
    },
    topDropdown: {
      bg: '#1f3525',
      text: '#f0faf2',
      border: '#406343',
      accent: '#a7c957',
      controlBg: '#29432f',
      activeBg: '#4f772d',
      activeText: '#ffffff',
    },
    modalPanel: {
      bg: '#233d2b',
      text: '#edf8ef',
      border: '#4c6f49',
      accent: '#84a98c',
      controlBg: '#2c4a36',
      activeBg: '#588157',
      activeText: '#ffffff',
    },
    pageBackground: {
      bg: '#0a1810',
      text: '#edf7ee',
      border: '#355e3b',
      accent: '#7fb069',
      controlBg: '#243b2f',
      activeBg: '#3a5a40',
      activeText: '#ffffff',
    },
    chatCard: {
      bg: '#0c1e12b8',
      text: '#edf8ef',
      border: '#4c6f49',
      accent: '#84a98c',
      controlBg: '#2c4a36',
      activeBg: '#588157',
      activeText: '#ffffff',
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
    },
    sidePanel: {
      bg: 'rgba(88, 64, 76, 0.95)',
      text: '#fff0f7',
      border: '#c098a8',
      accent: '#ff9ec8',
      controlBg: '#70505c',
      activeBg: 'rgba(190, 140, 160, 0.45)',
      activeText: '#ffffff',
    },
    inputPanel: {
      bg: 'rgba(92, 68, 80, 0.92)',
      text: '#fff8fb',
      border: '#cca0b0',
      accent: '#ffaed0',
      controlBg: '#74545e',
      activeBg: 'rgba(195, 145, 165, 0.4)',
      activeText: '#ffffff',
    },
    outputPanel: {
      bg: 'rgba(92, 68, 80, 0.92)',
      text: '#fff8fb',
      border: '#cca0b0',
      accent: '#ffc2dc',
      controlBg: '#74545e',
      activeBg: 'rgba(195, 145, 165, 0.4)',
      activeText: '#ffffff',
    },
    floatingWindow: {
      bg: 'rgba(100, 74, 86, 0.95)',
      text: '#fffafc',
      border: '#d4a8b8',
      accent: '#ffcce0',
      controlBg: '#7e5c68',
      activeBg: 'rgba(205, 155, 175, 0.42)',
      activeText: '#ffffff',
    },
    topDropdown: {
      bg: 'rgba(98, 72, 84, 0.92)',
      text: '#fff8fb',
      border: '#cca0b0',
      accent: '#ffb7d5',
      controlBg: '#785a66',
      activeBg: 'rgba(200, 150, 170, 0.4)',
      activeText: '#ffffff',
    },
    modalPanel: {
      bg: 'rgba(95, 70, 82, 0.92)',
      text: '#fff8fb',
      border: '#cca0b0',
      accent: '#ffc2dc',
      controlBg: '#74545e',
      activeBg: 'rgba(195, 145, 165, 0.4)',
      activeText: '#ffffff',
    },
    pageBackground: {
      bg: 'rgba(85, 60, 72, 0.95)',
      text: '#fff5fa',
      border: '#c8a0b0',
      accent: '#ffb7d5',
      controlBg: '#785a66',
      activeBg: 'rgba(200, 150, 170, 0.4)',
      activeText: '#ffffff',
    },
    chatCard: {
      bg: 'rgba(95, 68, 80, 0.72)',
      text: '#fff8fb',
      border: '#cca0b0',
      accent: '#ffc2dc',
      controlBg: '#74545e',
      activeBg: 'rgba(195, 145, 165, 0.4)',
      activeText: '#ffffff',
    },
  },
};

export function generateCSS(theme: RegionThemeConfig | null): string {
  if (!theme) {
    return '';
  }

  return REGION_NAMES.map((regionName) => {
    const declarations = COLOR_FIELDS.flatMap((field) => {
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

    return `${REGION_SELECTORS[regionName]} {\n${declarations.join('\n')}\n}`;
  })
    .filter(Boolean)
    .join('\n');
}
