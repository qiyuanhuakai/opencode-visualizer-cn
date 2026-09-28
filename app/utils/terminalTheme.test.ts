import { describe, expect, it } from 'vitest';
import { regionThemeToStorage, type ThemeStorageV2 } from './themeTokens';
import {
  AMBER_ATLAS_PRESET,
  ANIME_DREAM_PRESET,
  ANIME_NIGHT_PRESET,
  AURORA_TIDE_PRESET,
  SAKURA_PRESET,
  SOFT_WHITE_PRESET,
  LIGHT_MODE_PRESET,
  VIOLET_NOCTURNE_PRESET,
} from './regionTheme';
import { resolveTerminalTheme } from './terminalTheme';

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
    const [red, green, blue] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('terminal theme', () => {
  it.each([
    SOFT_WHITE_PRESET, LIGHT_MODE_PRESET, ANIME_DREAM_PRESET, AMBER_ATLAS_PRESET, SAKURA_PRESET,
    AURORA_TIDE_PRESET, VIOLET_NOCTURNE_PRESET, ANIME_NIGHT_PRESET,
  ])('matches every built-in shell surface with readable terminal colors', (preset) => {
    const theme = resolveTerminalTheme(regionThemeToStorage(preset));
    expect(theme.background).toBe(preset.floating?.shell?.backgroundColor);
    expect(contrast(theme.foreground!, theme.background!)).toBeGreaterThanOrEqual(4.5);
    for (const color of [
      theme.black, theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan, theme.white,
      theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow,
      theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite,
    ]) {
      expect(contrast(color!, theme.background!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps a dark theme dark with readable light ink', () => {
    const theme = resolveTerminalTheme(regionThemeToStorage(VIOLET_NOCTURNE_PRESET));
    expect(theme.background).toBe('#30273e');
    expect(contrast(theme.foreground!, theme.background!)).toBeGreaterThanOrEqual(4.5);
    expect(theme.cursor).toBe(theme.foreground);
  });

  it('rejects unreadable custom ink and uses the configured shell background', () => {
    const storage = {
      ...regionThemeToStorage(SOFT_WHITE_PRESET),
      floating: { shell: { backgroundColor: '#f0f1ed', text: '#fefefe' } },
      overrides: { 'floating-shell-background-color': '#f0f1ed', 'floating-shell-text': '#fefefe' },
    } as ThemeStorageV2;
    const theme = resolveTerminalTheme(storage);
    expect(theme.background).toBe('#f0f1ed');
    expect(contrast(theme.foreground!, theme.background!)).toBeGreaterThanOrEqual(4.5);
  });

  it('matches an imported theme with rgb shell colors', () => {
    const storage = {
      ...regionThemeToStorage(SOFT_WHITE_PRESET),
      floating: { shell: { backgroundColor: 'rgb(240 241 237)', text: 'rgb(38 48 56)' } },
      overrides: { 'floating-shell-background-color': 'rgb(240 241 237)', 'floating-shell-text': 'rgb(38 48 56)' },
    } as ThemeStorageV2;
    const theme = resolveTerminalTheme(storage);
    expect(theme.background).toBe('#f0f1ed');
    expect(theme.foreground).toBe('#263038');
  });

  it('uses the opaque CSS token when a theme supplies an alpha shell color', () => {
    const storage = regionThemeToStorage({
      ...SOFT_WHITE_PRESET,
      floating: {
        ...SOFT_WHITE_PRESET.floating,
        shell: { backgroundColor: 'rgba(240, 241, 237, 0.6)' },
      },
    });
    expect(resolveTerminalTheme(storage).background).toBe('#f0f1ed');
  });

  it('keeps text and ANSI colors readable on a medium custom shell surface', () => {
    const storage = {
      ...regionThemeToStorage(SOFT_WHITE_PRESET),
      overrides: { 'floating-shell-background-color': '#777777', 'floating-shell-text': '#888888' },
    } as ThemeStorageV2;
    const theme = resolveTerminalTheme(storage);
    expect(contrast(theme.foreground!, theme.background!)).toBeGreaterThanOrEqual(4.5);
    for (const color of [theme.red, theme.yellow, theme.blue, theme.brightWhite]) {
      expect(contrast(color!, theme.background!)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
