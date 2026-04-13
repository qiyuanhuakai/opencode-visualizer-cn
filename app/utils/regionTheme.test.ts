import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REGION_THEME,
  FOREST_PRESET,
  REGION_COLOR_FIELDS,
  REGION_NAMES,
  OCEAN_PRESET,
  REGION_THEME_EDITOR_FALLBACKS,
  SAKURA_PRESET,
  generateCSS,
  resolveRegionThemePresetName,
  resolveRegionThemePreset,
} from './regionTheme';

const COLOR_VALUE = /^(#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\([^)]+\))$/i;

describe('DEFAULT_REGION_THEME', () => {
  it('keeps every region color undefined so CSS fallbacks are used', () => {
    for (const regionName of REGION_NAMES) {
      for (const field of REGION_COLOR_FIELDS) {
        expect(DEFAULT_REGION_THEME.regions[regionName][field]).toBeUndefined();
      }
    }
  });
});

describe('region theme presets', () => {
  it('uses concrete hex values for every region color', () => {
    for (const preset of [OCEAN_PRESET, FOREST_PRESET, SAKURA_PRESET]) {
      for (const regionName of REGION_NAMES) {
        for (const field of REGION_COLOR_FIELDS) {
          expect(preset.regions[regionName][field]).toMatch(COLOR_VALUE);
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
        topDropdown: {
          border: '#334155',
        },
        modalPanel: {},
        pageBackground: {
          bg: '#08101f',
        },
        chatCard: {
          bg: 'rgba(10, 25, 45, 0.72)',
          border: '#1b5c85',
        },
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
    expect(css).toContain('html, body, #app {');
    expect(css).toContain('--region-page-bg: #08101f;');
    expect(css).toContain('.thread-block {');
    expect(css).toContain('--region-chat-bg: rgba(10, 25, 45, 0.72);');
    expect(css).toContain('--region-chat-border: #1b5c85;');
    expect(css).not.toContain('.modal, .provider-manager-modal, .status-monitor-popover {');
    expect(css).not.toContain('--region-top-text:');
    expect(css).not.toContain('.input-panel {');
  });

  it('includes text-muted variable when defined', () => {
    const css = generateCSS({
      name: 'custom',
      label: 'Custom',
      regions: {
        topPanel: {
          textMuted: '#94a3b8',
        },
        sidePanel: {},
        inputPanel: {},
        outputPanel: {},
        topDropdown: {},
        modalPanel: {},
        pageBackground: {},
        chatCard: {},
      },
    });

    expect(css).toContain('--region-top-text-muted: #94a3b8;');
  });

  it('resolves builtin preset names through one shared lookup', () => {
    expect(resolveRegionThemePreset('ocean')).toBe(OCEAN_PRESET);
    expect(resolveRegionThemePreset('forest')).toBe(FOREST_PRESET);
    expect(resolveRegionThemePreset('default')).toBe(DEFAULT_REGION_THEME);
    expect(resolveRegionThemePreset('missing')).toBeNull();
    expect(resolveRegionThemePresetName('sakura')).toBe('sakura');
    expect(resolveRegionThemePresetName('missing')).toBeNull();
  });

  it('exposes one shared editor fallback palette', () => {
    expect(REGION_THEME_EDITOR_FALLBACKS).toEqual({
      bg: '#1a1a2e',
      text: '#eaf6ff',
      border: '#334155',
      accent: '#4cc9f0',
      controlBg: '#16213e',
      activeBg: '#0f3460',
      activeText: '#ffffff',
      textMuted: '#94a3b8',
    });
  });
});
