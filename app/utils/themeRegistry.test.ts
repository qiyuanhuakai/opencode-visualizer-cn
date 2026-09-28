import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import sourceSchema from '../schema/theme.schema.json';
import { validateExternalThemeFile } from './themeFileValidation';

import {
  THEME_SCHEMA_URL,
  createExternalThemeDefinition,
  createThemeTemplate,
  listThemeRegistryEntries,
  parseExternalThemeFile,
  parseExternalThemeFileText,
  importExternalTheme,
  renameExternalTheme,
  upsertExternalThemes,
} from './themeRegistry';

const externalThemeFixture = {
  id: 'aurora',
  label: 'Aurora',
  badge: 'External',
  description: 'Northern-light inspired surfaces.',
  swatches: ['#08111f', '#11243b', '#67e8f9', '#eefbff'],
  floating: {
    surfaceBase: '#0f2033',
    syntaxText: '#172a3d',
    opacity: '0.9',
    backgroundImage: 'linear-gradient(135deg, rgba(8, 17, 31, 0.2), rgba(17, 36, 59, 0.32))',
    default: { accent: '#7dd3fc', opacity: '0.88' },
    shell: { accent: '#c084fc', backgroundColor: '#0d1527', text: '#123456', syntaxText: '#234567', opacity: '0.95', backgroundImage: 'linear-gradient(135deg, rgba(7, 20, 35, 0.18), rgba(19, 52, 77, 0.28))' },
    dialog: { accent: '#f59e0b', titlebarOpacity: '0.96' },
  },
  components: {
    dropdown: { bg: '#08111f', border: '#29506f', text: '#eefbff', textMuted: '#8fb8d0', controlBg: '#102033', hoverBg: '#16324f', activeBg: '#1d4f73', accent: '#67e8f9', shadow: '0 10px 22px rgba(2, 6, 23, 0.45)' },
    chip: { borderNeutral: '#29506f', borderSubtle: 'color-mix(in srgb, #29506f 80%, transparent)', bgNeutral: '#13283f', bgHover: '#1d4f73', fgNeutral: '#eefbff' },
    iconAction: { border: '#29506f', bg: '#102033', bgHover: '#1d4f73' },
    dock: { trayBg: 'rgba(8, 17, 31, 0.92)', trayBorder: '#29506f', chipBg: '#102033', chipText: '#eefbff', handle: '#8fb8d0' },
    formControl: { bg: '#13283f', border: '#29506f', text: '#eefbff', placeholder: '#8fb8d0', focusBorder: '#67e8f9', buttonBg: '#102033', buttonBorder: '#29506f', buttonText: '#eefbff', buttonPrimaryBg: '#1d4f73', buttonPrimaryBorder: '#67e8f9', buttonPrimaryText: '#ffffff' },
  },
  regions: {
    topPanel: { bg: '#11243b', text: '#eefbff', border: '#29506f', accent: '#67e8f9', controlBg: '#0d1b2a', activeBg: '#1d4f73', activeText: '#ffffff', textMuted: '#8fb8d0' },
    sidePanel: { bg: '#0b1727', text: '#eefbff', border: '#29506f', accent: '#67e8f9', controlBg: '#102033', activeBg: '#1d4f73', activeText: '#ffffff', textMuted: '#8fb8d0' },
    inputPanel: { bg: '#0a1a2a', text: '#eefbff', border: '#29506f', accent: '#67e8f9', controlBg: '#102033', activeBg: '#1d4f73', activeText: '#ffffff', textMuted: '#8fb8d0' },
    outputPanel: { bg: '#0f2033', text: '#eefbff', border: '#29506f', accent: '#67e8f9', controlBg: '#13283f', activeBg: '#1d4f73', activeText: '#ffffff', textMuted: '#8fb8d0' },
    topDropdown: { bg: '#0a1a2a', text: '#eefbff', border: '#29506f', accent: '#67e8f9', controlBg: '#102033', activeBg: '#1d4f73', activeText: '#ffffff', textMuted: '#8fb8d0' },
    modalPanel: { bg: '#11243b', text: '#eefbff', border: '#29506f', accent: '#67e8f9', controlBg: '#13283f', activeBg: '#1d4f73', activeText: '#ffffff', textMuted: '#8fb8d0' },
    loginScreen: { bg: '#102033', text: '#eefbff', border: '#29506f', accent: '#67e8f9', controlBg: '#13283f', activeBg: '#1d4f73', activeText: '#ffffff', textMuted: '#8fb8d0' },
    pageBackground: { bg: '#08111f', text: '#eefbff', border: '#29506f', accent: '#67e8f9', controlBg: '#11243b', activeBg: '#1d4f73', activeText: '#ffffff', textMuted: '#8fb8d0' },
    chatCard: { bg: '#11243bb8', text: '#eefbff', border: '#29506f', accent: '#67e8f9', controlBg: '#13283f', activeBg: '#1d4f73', activeText: '#ffffff', textMuted: '#8fb8d0' },
  },
} as const;

describe('themeRegistry', () => {
  it('lists Aurora Tide and Violet Nocturne in place of Ocean and Forest', () => {
    const ids = listThemeRegistryEntries().filter((entry) => entry.source === 'builtin').map((entry) => entry.id);
    expect(ids).toEqual(['default', 'aurora-tide', 'violet-nocturne', 'sakura', 'anime-night', 'anime-dream', 'amber-atlas', 'soft-white', 'light-mode']);
  });
  it('parses a valid external theme file', () => {
    const theme = parseExternalThemeFile(externalThemeFixture);
    expect(theme.id).toBe('aurora');
    expect(theme.regions.pageBackground.bg).toBe('#08111f');
    expect(theme.components?.dropdown?.accent).toBe('#67e8f9');
    expect(theme.components?.dock?.handle).toBe('#8fb8d0');
    expect(theme.components?.formControl?.buttonPrimaryBg).toBe('#1d4f73');
    expect(theme.floating?.surfaceBase).toBe('#0f2033');
    expect(theme.floating?.syntaxText).toBe('#172a3d');
    expect(theme.floating?.backgroundImage).toContain('linear-gradient');
    expect(theme.floating?.default?.accent).toBe('#7dd3fc');
    expect(theme.floating?.shell?.accent).toBe('#c084fc');
    expect(theme.floating?.shell?.backgroundColor).toBe('#0d1527');
    expect(theme.floating?.shell?.text).toBe('#123456');
    expect(theme.floating?.shell?.syntaxText).toBe('#234567');
    expect(theme.floating?.shell?.opacity).toBe('0.95');
    expect(theme.floating?.shell?.backgroundImage).toContain('linear-gradient');
  });

  it('parses a single theme text payload', () => {
    const theme = parseExternalThemeFileText(JSON.stringify(externalThemeFixture));
    expect(theme.label).toBe('Aurora');
  });

  it('rejects an incomplete theme instead of silently filling missing regions', () => {
    expect(() => parseExternalThemeFile({
      id: 'incomplete',
      label: 'Incomplete',
      regions: { topPanel: { bg: '#11243b' } },
    })).toThrow(/regions\.(sidePanel|inputPanel)/i);
  });

  it('rejects an invalid color with its field path', () => {
    expect(() => parseExternalThemeFile({
      ...externalThemeFixture,
      regions: {
        ...externalThemeFixture.regions,
        topPanel: { ...externalThemeFixture.regions.topPanel, bg: '#zzzzzz' },
      },
    })).toThrow(/regions\.topPanel\.bg/i);
  });

  it('rejects unsupported file format versions', () => {
    expect(() => parseExternalThemeFile({ ...externalThemeFixture, version: 99 })).toThrow(/version/i);
  });

  it('rejects builtin id collisions', () => {
    expect(() =>
      parseExternalThemeFile({
        ...externalThemeFixture,
        id: 'aurora-tide',
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

  it('renames a profile without changing its stable id', () => {
    const existing = [parseExternalThemeFile(externalThemeFixture)];
    expect(renameExternalTheme(existing, 'aurora', '  Northern Lights  ')).toMatchObject([
      { id: 'aurora', label: 'Northern Lights' },
    ]);
    expect(() => renameExternalTheme(existing, 'aurora', ' ')).toThrow(/name/i);
  });

  it('keeps both duplicate imports with distinct ids', () => {
    const existing = [parseExternalThemeFile(externalThemeFixture)];
    const incoming = parseExternalThemeFile({ ...externalThemeFixture, label: 'New Aurora' });
    const result = importExternalTheme(existing, incoming, 'keep-both');
    expect(result.selectedId).toBe('aurora-imported');
    expect(result.themes.map((theme) => theme.id)).toEqual(['aurora', 'aurora-imported']);
  });

  it('backs up the previous definition before replacing a duplicate', () => {
    const existing = [parseExternalThemeFile(externalThemeFixture)];
    const incoming = parseExternalThemeFile({ ...externalThemeFixture, label: 'New Aurora' });
    const result = importExternalTheme(existing, incoming, 'replace');
    expect(result.selectedId).toBe('aurora');
    expect(result.themes).toMatchObject([
      { id: 'aurora', label: 'New Aurora' },
      { id: 'aurora-backup', label: 'Aurora' },
    ]);
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
    expect(template.version).toBe(1);
    expect(template.id).toBe('my-theme');
    expect(template.regions.topPanel).toEqual({});
    expect(template.regions.loginScreen).toEqual({});
    expect(template.regions.chatCard).toEqual({});
    expect(template.components?.dropdown).toEqual({});
    expect(template.components?.chip).toEqual({});
    expect(template.components?.iconAction).toEqual({});
    expect(template.components?.dock).toEqual({});
    expect(template.components?.formControl).toEqual({});
    expect(template.components?.tab).toEqual({});
    expect(template.components?.badge).toEqual({});
    expect(template.components?.card).toEqual({});
    expect(template.components?.toggle).toEqual({});
    expect(template.components?.listRow).toEqual({});
    expect(template.components?.emptyState).toEqual({});
    expect(template.components?.actionButton).toEqual({});
    expect(template.components?.search).toEqual({});
    expect(template.floating).toEqual({});
  });

  it('creates exportable external definitions from runtime themes', () => {
    const entries = listThemeRegistryEntries();
    const aurora = entries.find((entry) => entry.id === 'aurora-tide');
    expect(aurora).toBeTruthy();
    const external = createExternalThemeDefinition(aurora!.theme, {
      badge: aurora!.badge,
      description: aurora!.description,
      swatches: aurora!.swatches,
    });
    expect(external.id).toBe('aurora-tide');
    expect(external.version).toBe(1);
    expect(external.swatches).toHaveLength(4);
    expect(external.regions.pageBackground.bg).toContain('linear-gradient');
    expect(external.components?.dropdown?.accent).toBe('#5de1c0');
    expect(external.floating?.surfaceBase).toBe('#192f3d');
    expect(external.floating?.default?.accent).toBe('#5de1c0');
    expect(external.floating?.shell?.backgroundColor).toBe('#192f3d');
    expect(external.floating?.reasoning?.backgroundColor).toBe('#1b3442');
    expect(external.floating?.backgroundImage).toContain('linear-gradient');
    expect(() => validateExternalThemeFile(JSON.parse(JSON.stringify(external)))).not.toThrow();
  });

  it('keeps the published schema identical to the source-importable schema', () => {
    expect(JSON.parse(readFileSync('app/public/schema/theme.schema.json', 'utf8'))).toEqual(sourceSchema);
  });

  it('accepts exported files from every built-in profile', () => {
    for (const entry of listThemeRegistryEntries().filter((theme) => theme.source === 'builtin')) {
      const exported = JSON.parse(JSON.stringify(createExternalThemeDefinition(entry.theme)));
      expect(() => validateExternalThemeFile(exported), entry.id).not.toThrow();
    }
  });
});
