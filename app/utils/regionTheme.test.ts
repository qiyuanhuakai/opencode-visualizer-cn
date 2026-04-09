import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REGION_THEME,
  FOREST_PRESET,
  OCEAN_PRESET,
  generateCSS,
  type RegionColors,
  type RegionName,
} from './regionTheme';

const REGION_NAMES: RegionName[] = [
  'topPanel',
  'sidePanel',
  'inputPanel',
  'outputPanel',
  'floatingWindow',
  'topDropdown',
  'modalPanel',
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

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

describe('DEFAULT_REGION_THEME', () => {
  it('keeps every region color undefined so CSS fallbacks are used', () => {
    for (const regionName of REGION_NAMES) {
      for (const field of COLOR_FIELDS) {
        expect(DEFAULT_REGION_THEME.regions[regionName][field]).toBeUndefined();
      }
    }
  });
});

describe('region theme presets', () => {
  it('uses concrete hex values for every region color', () => {
    for (const preset of [OCEAN_PRESET, FOREST_PRESET]) {
      for (const regionName of REGION_NAMES) {
        for (const field of COLOR_FIELDS) {
          expect(preset.regions[regionName][field]).toMatch(HEX_COLOR);
        }
      }
    }
  });
});

describe('generateCSS', () => {
  it('omits undefined values and includes defined variables with kebab-case names', () => {
    const css = generateCSS({
      name: 'custom',
      label: 'Custom',
      regions: {
        topPanel: {
          bg: '#1a1a2e',
          controlBg: '#16213e',
        },
        sidePanel: {
          text: '#d9f0ff',
        },
        inputPanel: {},
        outputPanel: {
          activeText: '#ffffff',
        },
        floatingWindow: {},
        topDropdown: {
          border: '#334155',
        },
        modalPanel: {},
      },
    });

    expect(css).toContain('.top-panel {');
    expect(css).toContain('--region-top-bg: #1a1a2e;');
    expect(css).toContain('--region-top-control-bg: #16213e;');
    expect(css).toContain('.side-panel {');
    expect(css).toContain('--region-side-text: #d9f0ff;');
    expect(css).toContain('.output-panel {');
    expect(css).toContain('--region-output-active-text: #ffffff;');
    expect(css).toContain('.top-center, .tree-menu {');
    expect(css).toContain('--region-top-dropdown-border: #334155;');
    expect(css).not.toContain('.modal, .provider-manager-modal, .status-monitor-popover {');
    expect(css).not.toContain('--region-top-text:');
    expect(css).not.toContain('.input-panel {');
    expect(css).not.toContain('.floating-window {');
  });
});
