import type { FloatingWindowEntry } from '../composables/useFloatingWindows';

export const FLOATING_WINDOW_THEME_TYPES = [
  'shell',
  'reasoning',
  'subagent',
  'tool',
  'file',
  'diff',
  'media',
  'dialog',
  'history',
  'debug',
] as const;

export const FLOATING_WINDOW_THEME_TYPES_WITH_DEFAULT = [
  'default',
  ...FLOATING_WINDOW_THEME_TYPES,
] as const;

export type FloatingWindowThemeType = (typeof FLOATING_WINDOW_THEME_TYPES)[number];
export type FloatingWindowThemeTypeWithDefault =
  (typeof FLOATING_WINDOW_THEME_TYPES_WITH_DEFAULT)[number];

function hasAccentColor(entry: Pick<FloatingWindowEntry, 'color'> | undefined): boolean {
  return typeof entry?.color === 'string' && entry.color.trim().length > 0;
}

export function resolveFloatingWindowThemeType(
  entryOrKey: Pick<FloatingWindowEntry, 'key' | 'color'> | string,
): FloatingWindowThemeTypeWithDefault {
  const key = typeof entryOrKey === 'string' ? entryOrKey : entryOrKey.key;

  if (key.startsWith('shell:')) return 'shell';
  if (key.startsWith('reasoning:') || key.startsWith('history-reasoning:')) return 'reasoning';
  if (key.startsWith('subagent:')) return 'subagent';
  if (key.startsWith('file-viewer:')) return 'file';
  if (
    key.startsWith('git-diff:') ||
    key.startsWith('message-diff:') ||
    key.startsWith('commit-diff:')
  ) {
    return 'diff';
  }
  if (key.startsWith('image-viewer:')) return 'media';
  if (key.startsWith('permission:') || key.startsWith('question:')) return 'dialog';
  if (key === 'thread-history') return 'history';
  if (key.startsWith('history-tool:')) return 'tool';
  if (key.startsWith('debug:')) return 'debug';

  if (typeof entryOrKey !== 'string' && hasAccentColor(entryOrKey)) {
    return 'tool';
  }

  return 'default';
}
