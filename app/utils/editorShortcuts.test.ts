import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_EDITOR_SHORTCUTS,
  createEditorKeyBindings,
  normalizeEditorShortcutMap,
  shortcutFromKeyboardEvent,
  validateEditorShortcutMap,
} from './editorShortcuts';

const mountedViews: EditorView[] = [];

function createView(doc: string, anchor: number) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
    }),
  });
  mountedViews.push(view);
  return view;
}

afterEach(() => {
  while (mountedViews.length > 0) mountedViews.pop()?.destroy();
  document.body.innerHTML = '';
});

describe('editor shortcuts', () => {
  it('normalizes configurable keys while preserving an intentionally disabled binding', () => {
    const shortcuts = normalizeEditorShortcutMap({
      indent: ' Ctrl-] ',
      outdent: '',
      moveLineUp: 'Alt-k',
    });

    expect(shortcuts.indent).toBe('Ctrl-]');
    expect(shortcuts.outdent).toBe('');
    expect(shortcuts.moveLineUp).toBe('Alt-k');
    expect(shortcuts.save).toBe(DEFAULT_EDITOR_SHORTCUTS.save);
  });

  it('treats malformed persisted values as untrusted input', () => {
    expect(() => normalizeEditorShortcutMap({ indent: 42 } as unknown)).not.toThrow();
    expect(normalizeEditorShortcutMap({ indent: 42 } as unknown).indent).toBe(DEFAULT_EDITOR_SHORTCUTS.indent);
    expect(normalizeEditorShortcutMap(['Alt-k'] as unknown)).toEqual(DEFAULT_EDITOR_SHORTCUTS);
  });

  it('avoids CodeMirror defaults and migrates legacy custom bindings', () => {
    expect(DEFAULT_EDITOR_SHORTCUTS.selectLine).not.toBe('Mod-l');
    expect(DEFAULT_EDITOR_SHORTCUTS.goToLine).not.toBe('F2');
    expect(DEFAULT_EDITOR_SHORTCUTS.duplicateLineUp).not.toBe(DEFAULT_EDITOR_SHORTCUTS.duplicateLineDown);

    const migrated = normalizeEditorShortcutMap({
      duplicateLine: 'Alt-d',
      toggleComment: 'Mod-;',
    });
    expect(migrated.duplicateLineDown).toBe('Alt-d');
    expect(migrated.toggleLineComment).toBe('Mod-;');
  });

  it('reports invalid and duplicate bindings and omits them from the keymap', () => {
    const shortcuts = normalizeEditorShortcutMap({
      indent: 'Hyper-s',
      outdent: '',
      moveLineUp: 'Alt-k',
      moveLineDown: 'Alt-k',
    });

    expect(validateEditorShortcutMap(shortcuts)).toEqual({
      indent: 'invalid',
      moveLineDown: 'duplicate',
      moveLineUp: 'duplicate',
    });
    expect(createEditorKeyBindings(shortcuts, () => undefined).map((binding) => binding.key)).not.toContain('Hyper-s');
    expect(createEditorKeyBindings(shortcuts, () => undefined).map((binding) => binding.key)).not.toContain('');
  });

  it('binds configured indentation and line movement commands', () => {
    const shortcuts = normalizeEditorShortcutMap({
      indent: 'Ctrl-]',
      moveLineUp: 'Alt-k',
    });
    const bindings = createEditorKeyBindings(shortcuts, () => undefined);
    const indentBinding = bindings.find((binding) => binding.key === 'Ctrl-]');
    const moveBinding = bindings.find((binding) => binding.key === 'Alt-k');
    const view = createView('one\ntwo', 4);

    expect(indentBinding?.run?.(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('one\n  two');
    expect(moveBinding?.run?.(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('  two\none');
  });

  it('turns the save shortcut into an editor command', () => {
    const onSave = vi.fn();
    const bindings = createEditorKeyBindings(DEFAULT_EDITOR_SHORTCUTS, onSave);
    const saveBinding = bindings.find((binding) => binding.key === 'Mod-s');
    const view = createView('content', 0);

    expect(saveBinding?.run?.(view)).toBe(true);
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('covers history, search, line, comment, folding, and completion commands', () => {
    expect(Object.keys(DEFAULT_EDITOR_SHORTCUTS)).toEqual(expect.arrayContaining([
      'undo',
      'redo',
      'find',
      'findNext',
      'findPrevious',
      'goToLine',
      'selectLine',
      'deleteLine',
      'toggleLineComment',
      'toggleBlockComment',
      'foldCode',
      'unfoldCode',
      'autocomplete',
    ]));
  });

  it('records browser key events in CodeMirror key syntax', () => {
    expect(shortcutFromKeyboardEvent({ key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe('Mod-Shift-k');
    expect(shortcutFromKeyboardEvent({ key: 'ArrowUp', ctrlKey: false, metaKey: false, altKey: true, shiftKey: false })).toBe('Alt-ArrowUp');
    expect(shortcutFromKeyboardEvent({ key: 'Tab', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBe('Tab');
    expect(shortcutFromKeyboardEvent({ key: 'Control', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBeNull();
  });
});
