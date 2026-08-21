import { startCompletion } from '@codemirror/autocomplete';
import {
  copyLineDown,
  copyLineUp,
  deleteLine,
  indentLess,
  indentMore,
  moveLineDown,
  moveLineUp,
  redo,
  selectLine,
  toggleBlockComment,
  toggleLineComment,
  undo,
} from '@codemirror/commands';
import { foldCode, unfoldCode } from '@codemirror/language';
import { findNext, findPrevious, gotoLine, openSearchPanel } from '@codemirror/search';
import type { KeyBinding } from '@codemirror/view';

export interface EditorShortcutMap {
  save: string;
  undo: string;
  redo: string;
  find: string;
  findNext: string;
  findPrevious: string;
  goToLine: string;
  selectLine: string;
  autocomplete: string;
  indent: string;
  outdent: string;
  deleteLine: string;
  moveLineUp: string;
  moveLineDown: string;
  duplicateLineUp: string;
  duplicateLineDown: string;
  toggleLineComment: string;
  toggleBlockComment: string;
  foldCode: string;
  unfoldCode: string;
}

export const DEFAULT_EDITOR_SHORTCUTS: Readonly<EditorShortcutMap> = Object.freeze({
  save: 'Mod-s',
  undo: 'Mod-z',
  redo: 'Mod-Shift-z',
  find: 'Mod-f',
  findNext: 'F3',
  findPrevious: 'Shift-F3',
  goToLine: 'Alt-g',
  selectLine: 'Shift-Mod-l',
  autocomplete: 'Ctrl-Space',
  indent: 'Tab',
  outdent: 'Shift-Tab',
  deleteLine: 'Shift-Mod-k',
  moveLineUp: 'Alt-ArrowUp',
  moveLineDown: 'Alt-ArrowDown',
  duplicateLineUp: 'Mod-Alt-ArrowUp',
  duplicateLineDown: 'Mod-Alt-ArrowDown',
  toggleLineComment: 'Mod-/',
  toggleBlockComment: 'Shift-Alt-a',
  foldCode: 'Ctrl-Shift-[',
  unfoldCode: 'Ctrl-Shift-]',
});

export type EditorShortcutValidationError = 'invalid' | 'duplicate';

const KEY_NAMES = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Enter',
  'Escape',
  'Backspace',
  'Delete',
  'Tab',
  'Space',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);
const MODIFIER_NAMES = new Set(['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta']);
const MODIFIER_KEYS = new Set(['Alt', 'Control', 'Meta', 'Shift']);
const SYMBOL_KEYS = new Set(['.', ',', '/', ';', "'", '[', ']', '\\', '`', '=', '-']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeEditorShortcutMap(value: unknown): EditorShortcutMap {
  const record = isRecord(value) ? value : {};
  return Object.fromEntries(
    Object.entries(DEFAULT_EDITOR_SHORTCUTS).map(([name, fallback]) => {
      const legacyName =
        name === 'duplicateLineDown'
          ? 'duplicateLine'
          : name === 'toggleLineComment'
            ? 'toggleComment'
            : null;
      const candidate = record[name] ?? (legacyName ? record[legacyName] : undefined);
      return [name, typeof candidate === 'string' ? candidate.trim() : fallback];
    }),
  ) as unknown as EditorShortcutMap;
}

function isValidEditorShortcutKey(value: string): boolean {
  if (value === '') return true;
  const parts = value.split('-');
  if (parts.some((part) => part.length === 0)) return false;
  const key = parts.pop();
  if (!key) return false;
  const modifiers = new Set<string>();
  for (const modifier of parts) {
    if (!MODIFIER_NAMES.has(modifier) || modifiers.has(modifier)) return false;
    modifiers.add(modifier);
  }
  return (
    key.length === 1 ||
    KEY_NAMES.has(key) ||
    SYMBOL_KEYS.has(key) ||
    /^F(?:[1-9]|1[0-2])$/.test(key)
  );
}

export function validateEditorShortcutMap(
  shortcuts: EditorShortcutMap,
): Partial<Record<keyof EditorShortcutMap, EditorShortcutValidationError>> {
  const errors: Partial<Record<keyof EditorShortcutMap, EditorShortcutValidationError>> = {};
  const bindings = new Map<string, Array<keyof EditorShortcutMap>>();
  for (const [name, key] of Object.entries(shortcuts) as Array<[keyof EditorShortcutMap, string]>) {
    if (!isValidEditorShortcutKey(key)) {
      errors[name] = 'invalid';
      continue;
    }
    if (key === '') continue;
    const names = bindings.get(key) ?? [];
    names.push(name);
    bindings.set(key, names);
  }
  for (const names of bindings.values()) {
    if (names.length < 2) continue;
    for (const name of names) errors[name] = 'duplicate';
  }
  return errors;
}

interface KeyboardShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

type ShortcutPlatform = 'mac' | 'other';

function detectShortcutPlatform(): ShortcutPlatform {
  if (typeof navigator === 'undefined') return 'other';
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? 'mac' : 'other';
}

export function shortcutFromKeyboardEvent(
  event: KeyboardShortcutEvent,
  platform = detectShortcutPlatform(),
): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const key =
    event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push(platform === 'mac' ? 'Ctrl' : 'Mod');
  if (event.metaKey) modifiers.push(platform === 'mac' ? 'Mod' : 'Meta');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  return [...modifiers, key].join('-');
}

export function formatShortcutForDisplay(
  shortcut: string,
  platform = detectShortcutPlatform(),
): string {
  return shortcut
    .split('-')
    .map((part) => (part === 'Mod' ? (platform === 'mac' ? '⌘' : 'Ctrl') : part))
    .join('-');
}

export function createEditorKeyBindings(
  shortcuts: EditorShortcutMap,
  onSave: () => void,
): KeyBinding[] {
  const commands: Record<keyof EditorShortcutMap, KeyBinding['run']> = {
    save: () => {
      onSave();
      return true;
    },
    undo,
    redo,
    find: openSearchPanel,
    findNext,
    findPrevious,
    goToLine: gotoLine,
    selectLine,
    autocomplete: startCompletion,
    indent: indentMore,
    outdent: indentLess,
    deleteLine,
    moveLineUp,
    moveLineDown,
    duplicateLineUp: copyLineUp,
    duplicateLineDown: copyLineDown,
    toggleLineComment,
    toggleBlockComment,
    foldCode,
    unfoldCode,
  };
  const errors = validateEditorShortcutMap(shortcuts);
  return (Object.keys(commands) as Array<keyof EditorShortcutMap>).flatMap((name) => {
    const key = shortcuts[name];
    if (!key || errors[name]) return [];
    return [{ key, run: commands[name], preventDefault: true }];
  });
}
