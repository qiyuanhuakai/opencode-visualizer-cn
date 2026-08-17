import { createApp, h, nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { useSettings } from '../composables/useSettings';
import CodeContent from './CodeContent.vue';

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe('CodeContent word wrapping', () => {
  it('lets an explicit false override the global floating-preview setting', async () => {
    const { floatingPreviewWordWrap } = useSettings();
    const previous = floatingPreviewWordWrap.value;
    floatingPreviewWordWrap.value = true;
    const root = document.createElement('div');
    document.body.appendChild(root);
    const app = createApp({
      render: () => h(CodeContent, { html: '<pre>code</pre>', variant: 'code', wordWrap: false }),
    });
    app.mount(root);
    cleanup = () => {
      app.unmount();
      root.remove();
      floatingPreviewWordWrap.value = previous;
    };
    await nextTick();

    expect(root.querySelector('.code-content')?.classList.contains('wrap-soft')).toBe(false);
  });

  it('constrains wrapped code rows to the preview width', async () => {
    const { floatingPreviewWordWrap } = useSettings();
    const previous = floatingPreviewWordWrap.value;
    floatingPreviewWordWrap.value = true;
    const root = document.createElement('div');
    document.body.appendChild(root);
    const html = [
      '<pre class="shiki"><code>',
      '<div class="code-row">',
      '<span class="code-gutter">1</span><span class="code-gutter"></span>',
      '<span class="line">a-very-long-line-without-a-natural-break</span>',
      '</div>',
      '</code></pre>',
    ].join('');
    const app = createApp({
      render: () => h(CodeContent, { html, variant: 'code' }),
    });
    app.mount(root);
    cleanup = () => {
      app.unmount();
      root.remove();
      floatingPreviewWordWrap.value = previous;
    };
    await nextTick();

    const content = root.querySelector<HTMLElement>('.code-content');
    expect(floatingPreviewWordWrap.value).toBe(true);
    expect(content?.classList.contains('wrap-soft')).toBe(true);
  });
});
