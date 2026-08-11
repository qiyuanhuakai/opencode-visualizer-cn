// Dev-only content-viewer QA harness (Task 8). Mounts the REAL ContentViewer
// with fixture PDF / ZIP / code-edit / markdown surfaces so vue-pdf-embed,
// ArchiveRenderer (libarchive-wasm) and CodeMirrorEditor (vue-codemirror6) can
// be exercised in a real browser against the upgraded dependency tree.
// Reachable only via Vite dev server; never bundled into a release build.
import { createApp, h } from 'vue';
import ContentViewer from '../components/viewers/ContentViewer.vue';
import { i18n } from '../i18n';
import '../styles/tailwind.css';

const PDF_B64 = 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0MSA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcwMCBUZCAoVklTIFBERiBPSykgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMzIgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MDIKJSVFT0YK';
const ZIP_B64 = 'UEsDBBQAAAAIAEeEC10TWNLFJwAAACQAAAAJAAAAaGVsbG8udHh0K8ssVkjLrCgpLUpVqMosUEjOzytJzStReLJ3wdOle5/smPZ8ag8AUEsDBBQAAAAIAEeEC10U+ScUIwAAACEAAAAPAAAAc3ViL2Rpci1ub3RlLm1kU1ZILErOyCxLVUjNKymq5OJ6Nn3pi/VrFYDUszlrXqyaBwBQSwECFAAUAAAACABHhAtdE1jSxScAAAAkAAAACQAAAAAAAAAAAAAAAAAAAAAAaGVsbG8udHh0UEsBAhQAFAAAAAgAR4QLXRT5JxQjAAAAIQAAAA8AAAAAAAAAAAAAAAAATgAAAHN1Yi9kaXItbm90ZS5tZFBLBQYAAAAAAgACAHQAAACeAAAAAAA';
const TS_CODE = 'const answer: number = 42;\nexport default answer;';
const PY_CODE = 'def greet():\n    return "你好"\n';
const MD_TEXT = '# 中文标题\n\n段落包含日本語と한국어。';

const surfaces: Array<{ id: string; title: string; props: Record<string, unknown> }> = [
  { id: 'pdf', title: 'PDF preview (vue-pdf-embed)', props: { path: 'sample.pdf', binaryBase64: PDF_B64, lang: 'text', theme: 'github-dark' } },
  { id: 'archive', title: 'Archive preview (libarchive-wasm)', props: { path: 'sample.zip', binaryBase64: ZIP_B64, lang: 'text', theme: 'github-dark' } },
  { id: 'edit-ts', title: 'CodeMirror edit (typescript)', props: { path: 'main.ts', fileContent: TS_CODE, lang: 'typescript', theme: 'github-dark', editing: true } },
  { id: 'edit-py', title: 'CodeMirror edit (python + CJK)', props: { path: 'main.py', fileContent: PY_CODE, lang: 'python', theme: 'github-dark', editing: true } },
  { id: 'md', title: 'Markdown rendered (CJK)', props: { path: 'README.md', fileContent: MD_TEXT, lang: 'markdown', theme: 'github-dark' } },
];

const app = createApp({
  setup() {
    return () =>
      surfaces.map((s) =>
        h('div', { class: 'surface', key: s.id }, [
          h('div', { class: 'surface-title' }, s.title),
          h(ContentViewer, s.props),
        ]),
      );
  },
});
app.use(i18n);
app.mount('#app');

Object.defineProperty(window, '__contentDriver', {
  configurable: true,
  value: {
    surfaces: surfaces.map((s) => s.id),
    surfaceCount: surfaces.length,
  },
});
