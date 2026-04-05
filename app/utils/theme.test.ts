import { describe, expect, it } from 'vitest';

import { opencodeTheme, resolveAgentColor, resolveTheme } from './theme';

describe('resolveTheme', () => {
  it('resolves hex values directly', () => {
    const theme = {
      defs: { red: '#ff0000' },
      theme: { primary: 'red' },
    };
    expect(resolveTheme(theme, 'dark')).toEqual({ primary: '#ff0000' });
  });

  it('resolves dark and light mode values', () => {
    const theme = {
      defs: { darkBg: '#000000', lightBg: '#ffffff' },
      theme: { background: { dark: 'darkBg', light: 'lightBg' } },
    };
    expect(resolveTheme(theme, 'dark')).toEqual({ background: '#000000' });
    expect(resolveTheme(theme, 'light')).toEqual({ background: '#ffffff' });
  });

  it('falls back to raw value when not in defs', () => {
    const theme = {
      defs: {},
      theme: { custom: 'raw-value' },
    };
    expect(resolveTheme(theme, 'dark')).toEqual({ custom: 'raw-value' });
  });
});

describe('resolveAgentColor', () => {
  it('returns explicit hex color directly', () => {
    expect(resolveAgentColor('a1', '#123456', [], {})).toBe('#123456');
  });

  it('resolves theme key when provided', () => {
    const theme = { primary: '#fab283' };
    expect(resolveAgentColor('a1', 'primary', [], theme)).toBe('#fab283');
  });

  it('cycles through palette based on visible agent index', () => {
    const theme = {
      secondary: '#5c9cf5',
      accent: '#9d7cd8',
      success: '#7fd88f',
      warning: '#f5a742',
      primary: '#fab283',
      error: '#e06c75',
      info: '#56b6c2',
    };
    const visible = [
      { name: 'a1' },
      { name: 'a2' },
      { name: 'a3' },
    ];
    expect(resolveAgentColor('a1', undefined, visible, theme)).toBe('#5c9cf5');
    expect(resolveAgentColor('a2', undefined, visible, theme)).toBe('#9d7cd8');
    expect(resolveAgentColor('a3', undefined, visible, theme)).toBe('#7fd88f');
  });

  it('falls back to hardcoded default when theme missing key', () => {
    expect(resolveAgentColor('a1', undefined, [{ name: 'a1' }], {})).toBe('#fab283');
  });

  it('uses index 0 when agent not in visible list', () => {
    const theme = { secondary: '#5c9cf5' };
    expect(resolveAgentColor('unknown', undefined, [{ name: 'a1' }], theme)).toBe('#5c9cf5');
  });
});

describe('opencodeTheme', () => {
  it('contains expected schema and defs', () => {
    expect(opencodeTheme.$schema).toBe('https://opencode.ai/theme.json');
    expect(opencodeTheme.defs.darkStep1).toBe('#0a0a0a');
    expect(opencodeTheme.defs.lightStep1).toBe('#ffffff');
  });
});
