import { createApp, nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';

import CodeMirrorEditor from './CodeMirrorEditor.vue';

describe('CodeMirrorEditor typography', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--floating-font-size');
    document.body.replaceChildren();
  });

  it('inherits the surrounding code font size when no editor override is set', async () => {
    document.documentElement.style.setProperty('--floating-font-size', '19px');
    const host = document.createElement('div');
    document.body.append(host);
    createApp(CodeMirrorEditor, { modelValue: 'const answer = 42;' }).mount(host);
    await nextTick();

    const editor = host.querySelector<HTMLElement>('.code-mirror-editor');
    expect(editor).not.toBeNull();
    expect(editor!.style.getPropertyValue('--editor-font-size')).toContain('--floating-font-size');
  });
});
