import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, redo, undo } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';

import CodeMirrorEditor from './CodeMirrorEditor.vue';

// Characterization of the CodeMirror model contract (EditorState/EditorView
// transaction round-trip + the vue-codemirror6 v-model sync used by
// CodeMirrorEditor.vue) on the CURRENT dependency tree. GREEN before the
// Task-8 CodeMirror bump; post-upgrade divergence must show RED here first.

describe('CodeMirror model round-trip', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('round-trips a doc through state transactions with CJK and code', () => {
    const state = EditorState.create({
      doc: 'const x = 1;',
      extensions: [javascript({ typescript: true })],
    });
    const inserted = state.update({ changes: { from: 0, insert: '中文// 注释\n' } });
    expect(inserted.docChanged).toBe(true);
    expect(inserted.state.doc.toString()).toBe('中文// 注释\nconst x = 1;');
    expect(inserted.state.doc.line(1).text).toBe('中文// 注释');

    const replaced = inserted.state.update({
      changes: { from: 0, to: inserted.state.doc.length, insert: 'def f():\n    return "ok"' },
    });
    expect(replaced.state.doc.toString()).toBe('def f():\n    return "ok"');
  });

  it('round-trips through a mounted EditorView dispatch', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const view = new EditorView({
      state: EditorState.create({ doc: 'let a = 1;' }),
      parent: host,
    });
    view.dispatch({ changes: { from: 0, insert: '日本語\ntext ' } });
    expect(view.state.doc.toString()).toBe('日本語\ntext let a = 1;');
    view.destroy();
  });

  it('supports undo/redo history across doc edits', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const view = new EditorView({
      state: EditorState.create({ doc: 'original', extensions: [history()] }),
      parent: host,
    });
    view.dispatch({ changes: { from: 0, to: 8, insert: 'edited 中文' } });
    expect(view.state.doc.toString()).toBe('edited 中文');

    undo(view);
    expect(view.state.doc.toString()).toBe('original');

    redo(view);
    expect(view.state.doc.toString()).toBe('edited 中文');
    view.destroy();
  });

  it('reports docChanged updates through updateListener (the @update contract)', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const seen: string[] = [];
    const view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          markdown(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) seen.push(update.state.doc.toString());
          }),
        ],
      }),
      parent: host,
    });
    view.dispatch({ changes: { from: 0, insert: '# 标题\n\n正文' } });
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    expect(seen.length).toBe(2);
    expect(seen[0]).toBe('# 标题\n\n正文');
    view.destroy();
  });

  it('syncs an external model value into the mounted editor and back out on edit', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const model = ref('const a = 1;');
    const App = defineComponent({
      setup() {
        return () =>
          h(CodeMirrorEditor, {
            modelValue: model.value,
            lang: 'typescript',
            'onUpdate:modelValue': (value: string) => {
              model.value = value;
            },
          });
      },
    });
    createApp(App).mount(host);
    await nextTick();
    await nextTick();

    const content = host.querySelector<HTMLElement>('.cm-content');
    expect(content).not.toBeNull();
    expect(content?.textContent ?? '').toContain('const a = 1;');

    model.value = 'let b: number = 2;';
    await nextTick();
    await nextTick();
    expect(content?.textContent ?? '').toContain('let b: number = 2;');
  });

  it('mounts the editor under every supported language mapping', async () => {
    for (const lang of ['typescript', 'tsx', 'javascript', 'jsx', 'python', 'markdown', 'json', 'html', 'css', 'yaml', 'xml', 'vue']) {
      const host = document.createElement('div');
      document.body.append(host);
      createApp(CodeMirrorEditor, { modelValue: 'value', lang }).mount(host);
      await nextTick();
      expect(host.querySelector('.code-mirror-editor')).not.toBeNull();
    }
  });
});
