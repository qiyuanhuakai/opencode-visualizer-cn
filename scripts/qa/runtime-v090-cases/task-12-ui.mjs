import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import { connectBrowserControl } from './task-12-browser-failures.mjs';
import { writeJson, artifact } from '../runtime-v090-evidence.mjs';
const exec = promisify(execFile);
export async function mountActualUi() {
  await import('/styles/tailwind.css');
  const { createApp, nextTick } = await import('/@id/virtual:task12-ui-vue');
  const { default: App } = await import('/App.vue');
  const { default: Question } = await import('/components/ToolWindow/Question.vue');
  const { i18n } = await import('/i18n/index.ts');
  const { useSettings } = await import('/composables/useSettings.ts');
  const { regionThemeToStorage } = await import('/utils/themeTokens.ts');
  const { LIGHT_MODE_PRESET, DEFAULT_REGION_THEME } = await import('/utils/regionTheme.ts');
  const themePresets = { light: regionThemeToStorage(LIGHT_MODE_PRESET), dark: regionThemeToStorage(DEFAULT_REGION_THEME) };
  const gate = await import('/runtime/migration/writerFreeze.ts');
  const application = createApp(App); application.use(i18n); application.mount('#app');
  const state = application._instance.setupState;
  state.uiInitState = 'ready'; state.connectionState = 'error'; state.selectedSessionId = 'qa-session';
  await nextTick();
  const request = { id: 'qa-question', sessionID: 'qa-session', questions: [{ header: '迁移前的回答', question: '保留这份草稿与回答？', options: [{ label: '保留', description: '原始文字与附件保持完整' }], custom: true }] };
  const question = createApp(Question, { request }); question.use(i18n); question.mount('#question');
  await nextTick(); await document.fonts.ready; document.querySelector('#question').style.display = 'none';
  const input = document.querySelector('.input-textarea'); if (!input) throw new Error('Actual App composer did not mount');
  input.value = '迁移前已接受的草稿 — copy remains available'; input.dispatchEvent(new Event('input', { bubbles: true }));
  state.attachments = [{ id: 'kept', filename: 'retained.txt', mime: 'text/plain', dataUrl: 'data:text/plain;base64,a2VwdA==' }];
  const answer = document.querySelector('#question textarea'); answer.value = '回答原文不会丢失'; answer.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  const mutationEvents = []; const inputComponent = document.querySelector('.input-panel').__vueParentComponent; const emit = inputComponent.emit;
  inputComponent.emit = (event, ...args) => { if (['send', 'add-attachments', 'update:message-input', 'update:selected-mode', 'update:selected-thinking', 'remove-attachment'].includes(event)) mutationEvents.push(event); emit(event, ...args); };
  window.__migrationUi = { themePresets, mutationEvents, gate, state, application, question, settings: useSettings(), nextTick, retained: [], fail: true };
  return { input: input.value, answer: answer.value, readonly: input.readOnly, disabled: input.disabled, questionDisabled: answer.disabled, component: application._instance.type.__file };
}
async function setState(input) {
  const qa = window.__migrationUi;
  if (input.width) qa.state.sidePanelCollapsed = input.width === 390;
  if (input.theme) qa.settings.themeStorage.value = qa.themePresets[input.theme];
  document.querySelector('#app').style.display = ''; 
  document.querySelector('#question').style.display = input.surface === 'question' ? '' : 'none';
  if (input.phase === 'frozen') { qa.state.connectionState = 'ready'; qa.mutationEvents.length = 0; }
  if (input.phase === 'frozen') await qa.gate.freezeLegacyWriters({ clientOrigin: 'ui-client', persist: async write => { if (qa.fail) throw new Error('controlled durable sink failure'); qa.retained.push(write); } });
  if (input.phase === 'paused') { qa.gate.retainFrozenLegacyWrite({ channel: 'storage', key: 'qa-pending-ui', value: 'accepted pending write' }); try { await qa.gate.flushFrozenLegacyWrites(); } catch { /* the visible paused state is the expected result */ } }
  if (input.phase === 'retry') { qa.fail = false; await qa.gate.retryFrozenLegacyWrites(); }
  if (input.phase === 'cutover') await qa.gate.completeLegacyCutover();
  await qa.nextTick(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const composer = document.querySelector('.input-textarea'); const answer = document.querySelector('#question textarea');
  composer.setSelectionRange(0, composer.value.length);
  return { phase: qa.gate.legacyWriterPhase(), composer: { value: composer.value, readonly: composer.readOnly, disabled: composer.disabled, selectedText: composer.value.slice(composer.selectionStart, composer.selectionEnd) }, answer: { value: answer.value, disabled: answer.disabled }, questionControlsDisabled: [...document.querySelectorAll('#question button,#question textarea')].every(element => element.disabled), retained: qa.retained, mutationEvents: qa.mutationEvents, pending: qa.gate.writerPendingState(), horizontalOverflow: document.documentElement.scrollWidth > innerWidth, bodyColor: getComputedStyle(document.body).color, theme: document.documentElement.getAttribute('data-region-theme'), background: getComputedStyle(document.querySelector('.app')).backgroundColor, sidePanelCollapsed: qa.state.sidePanelCollapsed, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, touch: navigator.maxTouchPoints } };
}
export async function uiScenario(root, outDir) {
  await mkdir(outDir, { recursive: true });
  const temporary = await mkdtemp(path.join(tmpdir(), 'vis-task12-ui-'));
  const resources = { profile: path.join(temporary, 'profile'), session: 'vis-task12-ui-' + process.pid, browserClosed: false, serverClosed: false, temporaryRemoved: false };
  const resourceFile = path.join(outDir, 'ui-resources.json'); writeJson(resourceFile, resources);
  const server = await createServer({ configFile: path.join(root, 'vite.config.ts'), appType: 'custom', plugins: [{ name: 'task12-ui-vue', resolveId: id => id === 'virtual:task12-ui-vue' ? id : undefined, load: id => id === 'virtual:task12-ui-vue' ? "export { createApp, nextTick } from 'vue';" : undefined }], server: { host: '127.0.0.1', port: 0, strictPort: false } });
  const completions = new Map(); let sequence = 0;
  server.middlewares.use('/task12-ui', (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Actual migration UI</title><style>html,body,#app{padding:0;margin:0;width:100%;height:100%}#question{position:fixed;inset:0;z-index:100000;overflow:auto;background:var(--theme-surface-page);color:var(--theme-text-primary);padding:20px;box-sizing:border-box}#question>.question-window{max-width:720px;margin:auto}</style><div id="app"></div><div id="question"></div>'); });
  server.middlewares.use('/qa-result', async (request, response) => { let text = ''; for await (const bytes of request) text += bytes; const value = JSON.parse(text); completions.get(value.id)?.(value); completions.delete(value.id); response.end('ok'); });
  const command = (...args) => exec('agent-browser', ['--session', resources.session, '--profile', resources.profile, ...args], { maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
  const evaluate = async (fn, input = {}) => {
    const id = ++sequence; let timer;
    const completion = new Promise((resolve, reject) => { timer = setTimeout(() => { completions.delete(id); reject(new Error('UI evaluation deadline')); }, 120000); completions.set(id, result => { clearTimeout(timer); if (result.error) reject(new Error(result.error)); else resolve(result.value); }); });
    await command('eval', `void (${fn.toString()})(${JSON.stringify(input)}).then(value => fetch('/qa-result',{method:'POST',body:JSON.stringify({id:${id},value})}),error=>fetch('/qa-result',{method:'POST',body:JSON.stringify({id:${id},error:String(error.stack||error)})})); 'started'`);
    return completion;
  };
  const results = []; const screenshots = []; let control;
  try {
    await server.listen(); resources.port = server.httpServer.address().port; writeJson(resourceFile, resources);
    await command('open', `http://127.0.0.1:${resources.port}/task12-ui`);
    control = await connectBrowserControl(JSON.parse((await command('get', 'cdp-url', '--json')).stdout).data.cdpUrl);
    const targets = await control.send('Target.getTargets'); const target = targets.targetInfos.find(value => value.type === 'page' && value.url.endsWith('/task12-ui')); assert(target);
    const attached = await control.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const emulate = async width => { await control.send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 900, deviceScaleFactor: width === 390 ? 3 : 1, mobile: width === 390 }, attached.sessionId); await control.send('Emulation.setTouchEmulationEnabled', { enabled: width === 390 }, attached.sessionId); };
    const initial = await evaluate(mountActualUi); results.push({ scenario: 'pre-migration', ...initial }); assert.equal(initial.readonly || initial.disabled, false); assert.equal(initial.questionDisabled, false);
    await command('click', '.input-textarea'); await command('press', 'End'); await command('press', '!');
    const typed = await evaluate(async () => ({ dom: document.querySelector('.input-textarea').value, accepted: window.__migrationUi.state.messageInput, connection: window.__migrationUi.state.connectionState }));
    assert.equal(typed.dom, typed.accepted); assert.equal(typed.connection, 'error'); assert(typed.dom.endsWith('!')); initial.input = typed.dom; results.push({ scenario: 'disconnected-editable', ...typed });
    await command('screenshot', path.join(outDir, 'ui-pre-migration-app.png'));
    for (const phase of ['frozen', 'paused', 'retry', 'cutover']) {
      const state = await evaluate(setState, { phase, surface: 'app' }); results.push({ scenario: phase, ...state }); writeJson(path.join(outDir, 'ui-states.json'), results);
      await command('screenshot', path.join(outDir, `ui-${phase}-app.png`));
      if (!state.composer.readonly) {
        await command('click', '.input-textarea'); await command('press', 'End'); await command('press', 'X');
        const mutation = await evaluate(async () => ({ dom: document.querySelector('.input-textarea').value, accepted: window.__migrationUi.state.messageInput }));
        writeJson(path.join(outDir, 'ui-rejected-input.json'), mutation); await command('screenshot', path.join(outDir, 'ui-rejected-input.png'));
      }
      assert.equal(state.composer.readonly, true, 'Actual composer must reject edits while preserving selectable text');
      await command('click', '.input-textarea'); await command('press', 'End'); await command('press', 'X'); await command('press', 'Control+Enter');
      const attempts = await evaluate(async () => {
        const input = document.querySelector('.input-textarea'); const transfer = new DataTransfer(); transfer.items.add(new File(['unaccepted'], 'paused.txt', { type: 'text/plain' }));
        const paste = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }); const drop = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
        input.dispatchEvent(paste); input.dispatchEvent(drop);
        const fileInput = document.querySelector('.input-panel input[type=file]'); fileInput.files = transfer.files; fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('.attachment-remove').click(); await window.__migrationUi.nextTick();
        return { input: input.value, accepted: window.__migrationUi.state.messageInput, pastePrevented: paste.defaultPrevented, dropPrevented: drop.defaultPrevented, attachmentIds: window.__migrationUi.state.attachments.map(item => item.id), removeDisabled: document.querySelector('.attachment-remove').disabled, mutationEvents: window.__migrationUi.mutationEvents };
      });
      results.push({ scenario: phase + '-attempted-edits', ...attempts }); assert.equal(attempts.input, initial.input); assert.equal(attempts.accepted, initial.input); assert.equal(attempts.pastePrevented && attempts.dropPrevented, true); assert.deepEqual(attempts.mutationEvents, []); assert.deepEqual(attempts.attachmentIds, ['kept']); assert.equal(attempts.removeDisabled, true);
      assert.equal(state.composer.selectedText, initial.input); assert.equal(state.answer.value, initial.answer); assert.equal(state.questionControlsDisabled, true);
      if (phase === 'retry') { assert.equal(state.phase, 'frozen'); assert.equal(state.retained.length, 1); }
    }
    for (const width of [390, 1440, 1920]) for (const theme of ['light', 'dark']) for (const surface of ['app', 'question']) {
      await emulate(width); const state = await evaluate(setState, { theme, surface, width });
      assert.equal(state.horizontalOverflow, false); const file = path.join(outDir, `ui-${surface}-${theme}-${width}.png`); await command('screenshot', file); screenshots.push(artifact(file, 'actual-ui-screenshot')); results.push({ scenario: `${surface}-${theme}-${width}`, ...state });
    }
    writeJson(path.join(outDir, 'ui-states.json'), { results, screenshots }); return { results, screenshots };
  } finally {
    try { if (control) { await control.close(); resources.controlClosed = true; } await command('close'); resources.browserClosed = true; } finally { await server.close(); resources.serverClosed = true; await rm(temporary, { recursive: true, force: true }); resources.temporaryRemoved = true; writeJson(resourceFile, resources); }
  }
}
if (process.argv[1] === new URL(import.meta.url).pathname) await uiScenario(process.cwd(), path.resolve(process.argv[2] ?? '.omo/evidence/vis-v090/task-12/ui'));
