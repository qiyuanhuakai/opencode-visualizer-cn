import { defineComponent, h, nextTick } from 'vue';
import CodeContent from '../../components/CodeContent.vue';
import CodeMirrorEditor from '../../components/renderers/CodeMirrorEditor.vue';
import CodeRenderer from '../../components/renderers/CodeRenderer.vue';
import { useSettings } from '../../composables/useSettings';
import { fixtureApi, installApp, waitForRender } from './runtime';

function codeRows(count: number): string {
  const longLine = `const unbroken = '${'abcdefghij'.repeat(90)}';`;
  return Array.from({ length: count }, (_, index) => {
    const content = index === 0 ? longLine : `const line${index} = ${index};`;
    return `<div class="code-row"><span class="code-gutter">${index + 1}</span><span class="line">${content}</span></div>`;
  }).join('');
}

export function codeScenario(): void {
  const settings = useSettings();
  settings.editorFontSizePx.value = null;
  const html = `<pre class="shiki"><code>${codeRows(600)}</code></pre>`;
  installApp(
    defineComponent({
      setup() {
        fixtureApi.setEditorFontSize = async (size) => {
          settings.editorFontSizePx.value = size;
          await nextTick();
          await waitForRender();
        };
        return () =>
          h('section', { style: { padding: '12px', display: 'grid', gap: '12px' } }, [
            h(
              'section',
              {
                id: 'wrap-contract',
                'aria-label': 'Wrapped code',
                style: { width: '280px', border: '1px solid #334155' },
              },
              [
                h(CodeContent, {
                  html: `<pre class="shiki"><code>${codeRows(1)}</code></pre>`,
                  variant: 'code',
                  wordWrap: true,
                }),
              ],
            ),
            h(
              'section',
              {
                id: 'nowrap-contract',
                'aria-label': 'Unwrapped code',
                style: { width: '280px', overflow: 'auto', border: '1px solid #334155' },
              },
              [
                h(CodeContent, {
                  html: `<pre class="shiki"><code>${codeRows(1)}</code></pre>`,
                  variant: 'code',
                  wordWrap: false,
                }),
              ],
            ),
            h(
              'section',
              {
                id: 'renderer-contract',
                'aria-label': 'Virtual code renderer',
                style: { width: 'min(100%, 620px)', height: '240px', border: '1px solid #334155' },
              },
              [h(CodeRenderer, { rawHtml: html, lang: 'text' })],
            ),
            h(
              'section',
              {
                id: 'editor-contract',
                'aria-label': 'Code editor typography',
                style: {
                  '--floating-font-size': '19px',
                  height: '180px',
                  width: 'min(100%, 620px)',
                  border: '1px solid #334155',
                },
              },
              [h(CodeMirrorEditor, { modelValue: 'const answer = 42;', lang: 'typescript' })],
            ),
          ]);
      },
    }),
  );
}
