import { redo, undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';

import CodeMirrorEditor from './CodeMirrorEditor.vue';

const supportedLanguages = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'vue',
  'astro',
  'svelte',
  'python',
  'markdown',
  'json',
  'html',
  'css',
  'yaml',
  'xml',
  'svg',
] as const;

const mountedApps: VueApp[] = [];

async function mountedEditorView(host: HTMLElement): Promise<EditorView> {
  await nextTick();
  await nextTick();
  const editor = host.querySelector<HTMLElement>('.cm-editor');
  expect(editor).not.toBeNull();
  const view = editor ? EditorView.findFromDOM(editor) : null;
  expect(view).not.toBeNull();
  if (!view) throw new TypeError('Mounted CodeMirror editor view was not found');
  return view;
}

describe('CodeMirrorEditor model round-trip', () => {
  afterEach(() => {
    mountedApps.splice(0).forEach((app) => app.unmount());
    document.body.replaceChildren();
  });

  it('propagates an editor transaction through the parent model, accepts an external update, and undoes it', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const model = ref('const x = 1;');
    const emittedValues: string[] = [];
    const Root = defineComponent({
      setup() {
        return () =>
          h(CodeMirrorEditor, {
            modelValue: model.value,
            lang: 'typescript',
            'onUpdate:modelValue': (value: string) => {
              emittedValues.push(value);
              model.value = value;
            },
          });
      },
    });
    const app = createApp(Root);
    mountedApps.push(app);
    app.mount(host);

    const view = await mountedEditorView(host);
    const editedValue = '中文// 注释\nconst x = 1;';
    view.dispatch({ changes: { from: 0, insert: '中文// 注释\n' } });
    await nextTick();

    expect(emittedValues).toEqual([editedValue]);
    expect(model.value).toBe(editedValue);
    expect(view.state.doc.toString()).toBe(editedValue);

    const externalValue = '# 标题\n\n正文';
    model.value = externalValue;
    await nextTick();
    await nextTick();
    expect(view.state.doc.toString()).toBe(externalValue);

    expect(undo(view)).toBe(true);
    await nextTick();
    expect(emittedValues.at(-1)).toBe('const x = 1;');
    expect(model.value).toBe('const x = 1;');
    expect(view.state.doc.toString()).toBe('const x = 1;');

    expect(redo(view)).toBe(true);
    await nextTick();
    expect(emittedValues.at(-1)).toBe(externalValue);
    expect(model.value).toBe(externalValue);
    expect(view.state.doc.toString()).toBe(externalValue);
  });

  it.each(supportedLanguages)('mounts and edits through the %s language mapping', async (lang) => {
    const host = document.createElement('div');
    document.body.append(host);
    const emittedValues: string[] = [];
    const app = createApp(CodeMirrorEditor, {
      modelValue: 'value',
      lang,
      'onUpdate:modelValue': (value: string) => emittedValues.push(value),
    });
    mountedApps.push(app);
    app.mount(host);

    const view = await mountedEditorView(host);
    view.dispatch({ changes: { from: view.state.doc.length, insert: `-${lang}` } });
    await nextTick();

    expect(view.state.doc.toString()).toBe(`value-${lang}`);
    expect(emittedValues).toEqual([`value-${lang}`]);
  });

  it('switches the active editor palette without losing the document or selection', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const theme = ref('github-dark');
    const Root = defineComponent({
      setup: () => () => h(CodeMirrorEditor, { modelValue: 'const value = 1;', lang: 'typescript', theme: theme.value }),
    });
    const app = createApp(Root);
    mountedApps.push(app);
    app.mount(host);

    const view = await mountedEditorView(host);
    view.dispatch({ selection: { anchor: 6, head: 11 } });
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);

    theme.value = 'github-light';
    await nextTick();
    await nextTick();

    const lightView = await mountedEditorView(host);
    expect(lightView.state.facet(EditorView.darkTheme)).toBe(false);
    expect(lightView.state.doc.toString()).toBe('const value = 1;');
    expect(lightView.state.selection.main.from).toBe(6);
    expect(lightView.state.selection.main.to).toBe(11);

    theme.value = 'github-dark';
    await nextTick();
    await nextTick();
    const darkView = await mountedEditorView(host);
    expect(darkView.state.facet(EditorView.darkTheme)).toBe(true);
    expect(darkView.state.doc.toString()).toBe('const value = 1;');
    expect(darkView.state.selection.main.to).toBe(11);
  });
});
