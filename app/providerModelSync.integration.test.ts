import { nextTick } from 'vue';
import { expect, it, vi } from 'vitest';
import type { CodexDriverOptions } from '../bridge/runtime/drivers/codexDriver.js';
import { parseEnvironmentId, parseHarnessInstanceId } from '../shared/runtime/identity.js';
import type { RuntimeDriverFactory } from '../bridge/runtime/runtimeDriverFactories.js';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mountRuntimeApp } from './test/runtimeAppHarness';

async function selectComposerModel(host: HTMLElement, modelId: string) {
  const trigger = await vi.waitFor(() => {
    const button = host.querySelector<HTMLButtonElement>('.input-dropdown-root .input-dropdown-button');
    expect(button?.disabled).toBe(false);
    return button!;
  }, { timeout: 5000 });
  trigger.click();
  const option = await vi.waitFor(() => {
    const candidate = [...host.querySelectorAll<HTMLElement>('.input-dropdown-root .ui-input-candidate-item')]
      .find(item => item.getAttribute('data-value') === JSON.stringify(modelId));
    expect(candidate).toBeTruthy();
    return candidate!;
  });
  option.click();
  await nextTick();
}

async function enterAndSend(host: HTMLElement, text: string) {
  const textarea = host.querySelector<HTMLTextAreaElement>('.input-textarea');
  expect(textarea).toBeInstanceOf(HTMLTextAreaElement);

  textarea!.value = text;
  textarea!.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  const readySend = await vi.waitFor(() => {
    const button = host.querySelector<HTMLButtonElement>('.send-button.primary');
    expect(button?.disabled).toBe(false);
    return button!;
  }, { timeout: 5000 });
  readySend.click();
}

it('reuses the official Codex session and creates a provider-matched session for a custom model', async () => {
  const requireFromRoot = createRequire(path.resolve(process.cwd(), 'package.json'));
  const { createCodexDriver } = requireFromRoot('./bridge/runtime/drivers/codexDriver.js') as typeof import('../bridge/runtime/drivers/codexDriver.js');
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let completeOfficial = () => {};
  const codexFactory: RuntimeDriverFactory = async context => {
    const directory = context.workspace.workspaces[0]!.root;
    const official = { id: 'thread-openai', cwd: directory, name: 'Official conversation', status: { type: 'idle' }, modelProvider: 'openai', turns: [] };
    let custom: typeof official | undefined;
    let receive: (data: string) => void = () => {};
    const transport: NonNullable<CodexDriverOptions['transport']> = {
      subscribe(callback) { receive = callback; return () => {}; },
      close() {},
      send(raw) {
        const message = JSON.parse(raw);
        if (message.id === undefined) return;
        const { id, method, params } = message;
        calls.push({ method, params });
        let result: unknown = {};
        switch (method) {
          case 'initialize': result = { userAgent: 'codex-cli/0.160.0 controlled' }; break;
          case 'thread/list': result = { data: params.archived ? [] : [official, ...(custom ? [custom] : [])], nextCursor: null }; break;
          case 'thread/turns/list': result = { data: [], nextCursor: null }; break;
          case 'thread/read': case 'thread/resume': result = { thread: params.threadId === custom?.id ? custom : official }; break;
          case 'thread/start':
            custom = { ...official, id: 'thread-custom', name: 'Custom conversation', modelProvider: params.modelProvider };
            result = { thread: custom };
            break;
          case 'model/list':
            result = { data: [{ id: 'official-model', model: 'official-model', displayName: 'Official Model', isDefault: true, supportedReasoningEfforts: [] }], nextCursor: null };
            break;
          case 'config/read':
            result = { config: { model_provider: 'openai', model: 'official-model', model_providers: {
              'custom-provider': { name: 'Custom Provider', models: { 'custom-model': { name: 'Custom Model' } } },
            } }, layers: [] };
            break;
          case 'turn/start': result = { turn: { id: `turn-${params.threadId}`, status: 'inProgress', items: [] } }; break;
        }
        receive(JSON.stringify({ id, result }));
        if (method === 'turn/start' && params.threadId === official.id) {
          completeOfficial = () => receive(JSON.stringify({ method: 'turn/completed', params: {
            threadId: params.threadId, turn: { id: `turn-${params.threadId}`, status: 'completed', items: [] },
          } }));
        }
      },
    };
    return createCodexDriver({
      ...context,
      environmentId: parseEnvironmentId(context.environmentId),
      harnessInstanceId: parseHarnessInstanceId(context.harnessInstanceId),
      processGeneration: context.authority().processGeneration,
      runtime: context.runtime as CodexDriverOptions['runtime'],
      allowedWorkspaces: context.workspace.workspaces.map(root => root.key),
      authorizeDirectory: async () => ({ canonicalPath: directory }),
      isProcessCurrent: () => true,
      transport,
    });
  };
  const fixture = await mountRuntimeApp([], { codexFactory });
  await fixture.connect();
  await fixture.select('Official conversation');

  await selectComposerModel(fixture.element, 'codex/official-model');
  await enterAndSend(fixture.element, 'official provider message');
  await vi.waitFor(() => expect(calls.filter(call => call.method === 'turn/start')).toMatchObject([
    { params: { threadId: 'thread-openai', model: 'official-model', input: [{ text: 'official provider message' }] } },
  ]), { timeout: 5000 });
  expect(calls.some(call => call.method === 'thread/start')).toBe(false);
  await vi.waitFor(() => {
    const frames = fixture.frames.map(frame => frame.value as { method?: string; id?: string; phase?: string; ok?: boolean });
    const request = frames.find(frame => frame.method === 'session.send');
    expect(request).toBeDefined();
    expect(frames).toContainEqual(expect.objectContaining({ id: request!.id, phase: 'native-executed', ok: true }));
  }, { timeout: 10000 });
  completeOfficial();

  await selectComposerModel(fixture.element, 'custom-provider/custom-model');
  await enterAndSend(fixture.element, 'custom provider message');
  await vi.waitFor(() => expect(calls.filter(call => call.method === 'turn/start')).toMatchObject([
    { params: { threadId: 'thread-openai' } },
    { params: { threadId: 'thread-custom', model: 'custom-model', input: [{ text: 'custom provider message' }] } },
  ]), { timeout: 5000 });
  expect(calls.filter(call => call.method === 'thread/start')).toMatchObject([
    { params: { modelProvider: 'custom-provider', model: 'custom-model' } },
  ]);
}, 30000);
