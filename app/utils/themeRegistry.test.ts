import { describe, expect, it } from 'vitest';

import {
  THEME_SCHEMA_URL,
  createExternalThemeDefinition,
  createThemeTemplate,
  listThemeRegistryEntries,
  parseExternalThemeFile,
  parseExternalThemeFileText,
  upsertExternalThemes,
} from './themeRegistry';

const externalThemeFixture = {
  id: 'aurora',
  label: 'Aurora',
  badge: 'External',
  description: 'Northern-light inspired surfaces.',
  swatches: ['#08111f', '#11243b', '#67e8f9', '#eefbff'],
  regions: {
    topPanel: { bg: '#11243b', text: '#eefbff', border: '#29506f', accent: '#67e8f9', controlBg: '#0d1b2a', activeBg: '#1d4f73', activeText: '#ffffff', textMuted: '#8fb8d0' },
    sidePanel: { bg: '#0b1727', text: '#eefbff', border: '#29506f', accent: '#67e8f9', controlBg: '#102033', activeBg: '#1d4f73', activeText: '#ffffff', textMuted: '#8fb8d0' },
    inputPanel: { bg: '#0a1a2a', text: '#eefbff', border: '#29506f', accent: '#67e8f9', controlBg: '#102033', activeBg: '#1d4f73', activeText: '#ffffff', textMuted: '#8fb8d0' },
    outputPanel: { bg: '#0f2033', text: '#eefbff', border: '#29506f', accent: '#67e8f9', controlBg: '#13283f', activeBg: '#1d4f73', activeText: '#ffffff', textMuted: '#8fb8d0' },
    topDropdown: { bg: '#0a1a2a', text: '#eefbff', border: '#29506f', accent: '#67e8f9', controlBg: '#102033', activeBg: '#1d4f73', activeText: '#ffffff', textMuted: '#8fb8d0' },
    modalPanel: { bg: '#11243b', text: '#eefbff', border: '#29506f', accent: '#67e8f9', controlBg: '#13283f', activeBg: '#1d4f73', activeText: '#ffffff', textMuted: '#8fb8d0' },
    pageBackground: { bg: '#08111f', text: '#eefbff', border: '#29506f', accent: '#67e8f9', controlBg: '#11243b', activeBg: '#1d4f73', activeText: '#ffffff', textMuted: '#8fb8d0' },
    chatCard: { bg: '#11243bb8', text: '#eefbff', border: '#29506f', accent: '#67e8f9', controlBg: '#13283f', activeBg: '#1d4f73', activeText: '#ffffff', textMuted: '#8fb8d0' },
  },
} as const;

describe('themeRegistry', () => {
  it('parses a valid external theme file', () => {
    const theme = parseExternalThemeFile(externalThemeFixture);
    expect(theme.id).toBe('aurora');
    expect(theme.regions.pageBackground.bg).toBe('#08111f');
  });

  it('parses a single theme text payload', () => {
    const theme = parseExternalThemeFileText(JSON.stringify(externalThemeFixture));
    expect(theme.label).toBe('Aurora');
  });

  it('rejects builtin id collisions', () => {
    expect(() =>
      parseExternalThemeFile({
        ...externalThemeFixture,
        id: 'ocean',
      }),
    ).toThrow(/conflicts with a built-in theme/i);
  });

  it('merges imported external themes by id', () => {
    const existing = [parseExternalThemeFile(externalThemeFixture)];
    const next = [parseExternalThemeFile({
      ...externalThemeFixture,
      label: 'Aurora Night',
    })];
    const merged = upsertExternalThemes(existing, next);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.label).toBe('Aurora Night');
  });

  it('lists builtin and external registry entries together', () => {
    const external = [parseExternalThemeFile(externalThemeFixture)];
    const entries = listThemeRegistryEntries(external);
    expect(entries.some((entry) => entry.id === 'default')).toBe(true);
    expect(entries.some((entry) => entry.id === 'aurora' && entry.source === 'external')).toBe(true);
  });

  it('creates a theme template with schema metadata', () => {
    const template = createThemeTemplate();
    expect(template.$schema).toBe(THEME_SCHEMA_URL);
    expect(template.id).toBe('my-theme');
    expect(template.regions.topPanel).toEqual({});
    expect(template.regions.chatCard).toEqual({});
  });

  it('creates exportable external definitions from runtime themes', () => {
    const entries = listThemeRegistryEntries();
    const ocean = entries.find((entry) => entry.id === 'ocean');
    expect(ocean).toBeTruthy();
    const external = createExternalThemeDefinition(ocean!.theme, {
      badge: ocean!.badge,
      description: ocean!.description,
      swatches: ocean!.swatches,
    });
    expect(external.id).toBe('ocean');
    expect(external.swatches).toHaveLength(4);
    expect(external.regions.pageBackground.bg).toBe('#b8c9d8');
  });
});
