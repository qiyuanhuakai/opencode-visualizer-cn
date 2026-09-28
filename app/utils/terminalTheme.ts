import type { ITheme } from '@xterm/xterm';
import { LIGHT_SYNTAX_THEME, resolveSyntaxTheme, type ThemeStorageV2 } from './themeTokens';
import { parseOpaqueColor, rgbHex, type RgbColor } from './colorValue';

function luminance(value: RgbColor): number {
  const [red, green, blue] = value.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const foregroundRgb = parseOpaqueColor(foreground);
  const backgroundRgb = parseOpaqueColor(background);
  if (!foregroundRgb || !backgroundRgb) return 0;
  const values = [luminance(foregroundRgb), luminance(backgroundRgb)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function readableAnsiColor(color: string, background: string, light: boolean): string {
  if (contrast(color, background) >= 4.5) return color;
  const channels = parseOpaqueColor(color)!;
  const target = light ? 0 : 255;
  let low = 0;
  let high = 1;
  for (let index = 0; index < 16; index += 1) {
    const amount = (low + high) / 2;
    const candidate = `#${channels.map((channel) => Math.round(channel + (target - channel) * amount).toString(16).padStart(2, '0')).join('')}`;
    if (contrast(candidate, background) >= 4.5) high = amount;
    else low = amount;
  }
  return `#${channels.map((channel) => Math.round(channel + (target - channel) * high).toString(16).padStart(2, '0')).join('')}`;
}

const LIGHT_ANSI: ITheme = {
  black: '#30363d', red: '#b42332', green: '#116329', yellow: '#895900',
  blue: '#0969ad', magenta: '#8250a4', cyan: '#0e7490', white: '#57606a',
  brightBlack: '#57606a', brightRed: '#a91b2b', brightGreen: '#0b6b35',
  brightYellow: '#805600', brightBlue: '#075d9c', brightMagenta: '#753fa0',
  brightCyan: '#08718a', brightWhite: '#30363d',
};

const DARK_ANSI: ITheme = {
  black: '#343b47', red: '#f07178', green: '#a3d9a5', yellow: '#e7c787',
  blue: '#8dbdf0', magenta: '#c5a5e8', cyan: '#8ed3da', white: '#dce3eb',
  brightBlack: '#8b97a6', brightRed: '#ff9299', brightGreen: '#bde8bc',
  brightYellow: '#f3dda2', brightBlue: '#a8d2ff', brightMagenta: '#dfbdf4',
  brightCyan: '#afe6e8', brightWhite: '#f7f9fb',
};

export function resolveTerminalTheme(storage: ThemeStorageV2 | null | undefined): ITheme {
  const floating = storage?.floating;
  const backgroundCandidates = [
    storage?.overrides['floating-shell-background-color'],
    storage?.overrides['floating-default-background-color'],
    storage?.overrides['floating-surface-base'],
    floating?.shell?.backgroundColor,
    floating?.default?.backgroundColor,
    floating?.surfaceBase,
  ];
  const background = backgroundCandidates.map(parseOpaqueColor).find((color) => color !== null);
  const resolvedBackground = background
    ? rgbHex(background)
    : resolveSyntaxTheme(storage) === LIGHT_SYNTAX_THEME ? '#f4f3ef' : '#1a1d24';
  const light = contrast('#000000', resolvedBackground) >= contrast('#ffffff', resolvedBackground);
  const preferredForeground = light ? '#263038' : '#e2e8f0';
  const fallbackForeground = contrast(preferredForeground, resolvedBackground) >= 4.5
    ? preferredForeground
    : light ? '#000000' : '#ffffff';
  const foregroundCandidates = [
    storage?.overrides['floating-shell-text'],
    storage?.overrides['floating-default-text'],
    storage?.overrides['floating-text'],
    floating?.shell?.text,
    floating?.default?.text,
    floating?.text,
  ];
  const foreground = foregroundCandidates.map(parseOpaqueColor)
    .find((color) => color && contrast(rgbHex(color), resolvedBackground) >= 4.5);
  const resolvedForeground = foreground ? rgbHex(foreground) : fallbackForeground;
  const ansi = Object.fromEntries(Object.entries(light ? LIGHT_ANSI : DARK_ANSI)
    .map(([key, color]) => [key, readableAnsiColor(color, resolvedBackground, light)])) as ITheme;

  return {
    ...ansi,
    background: resolvedBackground,
    foreground: resolvedForeground,
    cursor: resolvedForeground,
    cursorAccent: resolvedBackground,
    selectionBackground: light ? 'rgba(68, 107, 144, 0.25)' : 'rgba(148, 163, 184, 0.3)',
  };
}
