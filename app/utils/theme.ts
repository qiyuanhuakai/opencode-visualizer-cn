// app/utils/theme.ts

export type ThemeColors = {
  [key: string]: string;
};

export type ThemeJson = {
  $schema?: string;
  defs: { [key: string]: string };
  theme: {
    [key: string]: string | { dark: string; light: string };
  };
};

export const TOOL_ACCENT_COLORS = {
  bash: '#a855f7',
  read: '#60a5fa',
  grep: '#facc15',
  glob: '#facc15',
  list: '#60a5fa',
  edit: '#f97316',
  multiedit: '#f97316',
  apply_patch: '#f97316',
  write: '#f97316',
  webfetch: '#2dd4bf',
  websearch: '#2dd4bf',
  codesearch: '#2dd4bf',
  task: '#818cf8',
  batch: '#818cf8',
  plan_enter: '#94a3b8',
  plan_exit: '#94a3b8',
} as const;

const DEFAULT_TOOL_ACCENT_COLOR = '#64748b';

export const opencodeTheme: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  defs: {
    darkStep1: '#0a0a0a',
    darkStep2: '#141414',
    darkStep3: '#1e1e1e',
    darkStep4: '#282828',
    darkStep5: '#323232',
    darkStep6: '#3c3c3c',
    darkStep7: '#484848',
    darkStep8: '#606060',
    darkStep9: '#fab283',
    darkStep10: '#ffc09f',
    darkStep11: '#808080',
    darkStep12: '#eeeeee',
    darkSecondary: '#5c9cf5',
    darkAccent: '#9d7cd8',
    darkRed: '#e06c75',
    darkOrange: '#f5a742',
    darkGreen: '#7fd88f',
    darkCyan: '#56b6c2',
    darkYellow: '#e5c07b',
    lightStep1: '#ffffff',
    lightStep2: '#fafafa',
    lightStep3: '#f5f5f5',
    lightStep4: '#ebebeb',
    lightStep5: '#e1e1e1',
    lightStep6: '#d4d4d4',
    lightStep7: '#b8b8b8',
    lightStep8: '#a0a0a0',
    lightStep9: '#3b7dd8',
    lightStep10: '#2968c3',
    lightStep11: '#8a8a8a',
    lightStep12: '#1a1a1a',
    lightSecondary: '#7b5bb6',
    lightAccent: '#d68c27',
    lightRed: '#d1383d',
    lightOrange: '#d68c27',
    lightGreen: '#3d9a57',
    lightCyan: '#318795',
    lightYellow: '#b0851f',
  },
  theme: {
    primary: {
      dark: 'darkStep9',
      light: 'lightStep9',
    },
    secondary: {
      dark: 'darkSecondary',
      light: 'lightSecondary',
    },
    accent: {
      dark: 'darkAccent',
      light: 'lightAccent',
    },
    error: {
      dark: 'darkRed',
      light: 'lightRed',
    },
    warning: {
      dark: 'darkOrange',
      light: 'lightOrange',
    },
    success: {
      dark: 'darkGreen',
      light: 'lightGreen',
    },
    info: {
      dark: 'darkCyan',
      light: 'lightCyan',
    },
    text: {
      dark: 'darkStep12',
      light: 'lightStep12',
    },
    textMuted: {
      dark: 'darkStep11',
      light: 'lightStep11',
    },
    background: {
      dark: 'darkStep1',
      light: 'lightStep1',
    },
    backgroundPanel: {
      dark: 'darkStep2',
      light: 'lightStep2',
    },
    backgroundElement: {
      dark: 'darkStep3',
      light: 'lightStep3',
    },
    border: {
      dark: 'darkStep7',
      light: 'lightStep7',
    },
    borderActive: {
      dark: 'darkStep8',
      light: 'lightStep8',
    },
    borderSubtle: {
      dark: 'darkStep6',
      light: 'lightStep6',
    },
    diffAdded: {
      dark: '#4fd6be',
      light: '#1e725c',
    },
    diffRemoved: {
      dark: '#c53b53',
      light: '#c53b53',
    },
    diffContext: {
      dark: '#828bb8',
      light: '#7086b5',
    },
    diffHunkHeader: {
      dark: '#828bb8',
      light: '#7086b5',
    },
    diffHighlightAdded: {
      dark: '#b8db87',
      light: '#4db380',
    },
    diffHighlightRemoved: {
      dark: '#e26a75',
      light: '#f52a65',
    },
    diffAddedBg: {
      dark: '#20303b',
      light: '#d5e5d5',
    },
    diffRemovedBg: {
      dark: '#37222c',
      light: '#f7d8db',
    },
    diffContextBg: {
      dark: 'darkStep2',
      light: 'lightStep2',
    },
    diffLineNumber: {
      dark: 'darkStep3',
      light: 'lightStep3',
    },
    diffAddedLineNumberBg: {
      dark: '#1b2b34',
      light: '#c5d5c5',
    },
    diffRemovedLineNumberBg: {
      dark: '#2d1f26',
      light: '#e7c8cb',
    },
    markdownText: {
      dark: 'darkStep12',
      light: 'lightStep12',
    },
    markdownHeading: {
      dark: 'darkAccent',
      light: 'lightAccent',
    },
    markdownLink: {
      dark: 'darkStep9',
      light: 'lightStep9',
    },
    markdownLinkText: {
      dark: 'darkCyan',
      light: 'lightCyan',
    },
    markdownCode: {
      dark: 'darkGreen',
      light: 'lightGreen',
    },
    markdownBlockQuote: {
      dark: 'darkYellow',
      light: 'lightYellow',
    },
    markdownEmph: {
      dark: 'darkYellow',
      light: 'lightYellow',
    },
    markdownStrong: {
      dark: 'darkOrange',
      light: 'lightOrange',
    },
    markdownHorizontalRule: {
      dark: 'darkStep11',
      light: 'lightStep11',
    },
    markdownListItem: {
      dark: 'darkStep9',
      light: 'lightStep9',
    },
    markdownListEnumeration: {
      dark: 'darkCyan',
      light: 'lightCyan',
    },
    markdownImage: {
      dark: 'darkStep9',
      light: 'lightStep9',
    },
    markdownImageText: {
      dark: 'darkCyan',
      light: 'lightCyan',
    },
    markdownCodeBlock: {
      dark: 'darkStep12',
      light: 'lightStep12',
    },
    syntaxComment: {
      dark: 'darkStep11',
      light: 'lightStep11',
    },
    syntaxKeyword: {
      dark: 'darkAccent',
      light: 'lightAccent',
    },
    syntaxFunction: {
      dark: 'darkStep9',
      light: 'lightStep9',
    },
    syntaxVariable: {
      dark: 'darkRed',
      light: 'lightRed',
    },
    syntaxString: {
      dark: 'darkGreen',
      light: 'lightGreen',
    },
    syntaxNumber: {
      dark: 'darkOrange',
      light: 'lightOrange',
    },
    syntaxType: {
      dark: 'darkYellow',
      light: 'lightYellow',
    },
    syntaxOperator: {
      dark: 'darkCyan',
      light: 'lightCyan',
    },
    syntaxPunctuation: {
      dark: 'darkStep12',
      light: 'lightStep12',
    },
  },
};

export function resolveTheme(themeJson: ThemeJson, mode: 'dark' | 'light'): ThemeColors {
  const resolved: ThemeColors = {};
  const defs = themeJson.defs;

  function resolveValue(val: string): string {
    if (val.startsWith('#')) return val;
    if (defs[val]) return defs[val];
    return val;
  }

  for (const key in themeJson.theme) {
    const value = themeJson.theme[key];
    if (typeof value === 'string') {
      resolved[key] = resolveValue(value);
    } else {
      resolved[key] = resolveValue(value[mode]);
    }
  }

  return resolved;
}

export function resolveAgentColor(
  agentName: string,
  agentColor: string | undefined | null,
  visibleAgents: Array<{ name: string; color?: string }>,
  theme: ThemeColors,
): string {
  if (agentColor && agentColor.startsWith('#')) {
    return agentColor;
  }

  if (agentColor && theme[agentColor]) {
    return theme[agentColor];
  }

  const cycleColors = ['secondary', 'accent', 'success', 'warning', 'primary', 'error', 'info'];

  const index = visibleAgents.findIndex((a) => a.name === agentName);

  const colorKey = cycleColors[(index === -1 ? 0 : index) % cycleColors.length];
  return theme[colorKey] || '#fab283';
}

export function resolveToolAccentColor(tool: string): string {
  return TOOL_ACCENT_COLORS[tool as keyof typeof TOOL_ACCENT_COLORS] ?? DEFAULT_TOOL_ACCENT_COLOR;
}
