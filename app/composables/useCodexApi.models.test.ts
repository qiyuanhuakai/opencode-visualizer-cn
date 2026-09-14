import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexApi } from './useCodexApi';
import type { CodexPromptResult } from '../backends/codex/codexAdapter';
import { createAdapterMock, deferred, resetCodexApiTestState } from './useCodexApi.test-helpers';

describe('useCodexApi', () => {
  beforeEach(resetCodexApiTestState);

  it.each([
    { provider: 'openai', expected: 'astra-choice' },
    { provider: 'proxy', expected: 'proxy/gpt-6-astra' },
  ])('initializes models from configured provider $provider', async ({ provider, expected }) => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    mock.adapter.readConfig = vi.fn().mockResolvedValue({
      config: { model: 'gpt-6-astra', model_provider: provider },
    });
    mock.adapter.listModels = vi.fn().mockResolvedValue({
      data: [
        { id: 'codex-auto-review', model: 'codex-auto-review', isDefault: true },
        { id: 'astra-choice', model: 'gpt-6-astra' },
      ],
      nextCursor: null,
    });
    api.config.value = null;
    api.selectModel('');

    await api.refreshModels();

    expect(api.selectedModel.value).toBe(expected);
    api.disconnect();
  });

  it('retains a model selected while initial model configuration is loading', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const pendingConfig = deferred<{ config: Record<string, unknown> }>();
    mock.adapter.readConfig = vi.fn(() => pendingConfig.promise);
    mock.adapter.listModels = vi.fn().mockResolvedValue({
      data: [{ id: 'catalog-default', model: 'catalog-default', isDefault: true }],
      nextCursor: null,
    });
    api.config.value = null;
    api.selectModel('');

    const refresh = api.refreshModels();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    api.selectModel('user-choice');
    pendingConfig.resolve({ config: { model: 'catalog-default' } });
    await refresh;

    expect(api.selectedModel.value).toBe('user-choice');
    api.disconnect();
  });

  it('preserves the sent model and provider through echoes, completion hydration and a fresh page instance', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    api.selectModel('codex/gpt-6-astra');
    await api.sendPrompt('Keep model metadata', { effort: 'medium' });
    const clientId = vi.mocked(mock.adapter.sendPrompt).mock.calls[0]?.[0]?.clientUserMessageId;
    const items = [
      {
        type: 'userMessage',
        id: 'wire-user',
        clientId,
        content: [{ type: 'text', text: 'Keep model metadata' }],
      },
      { type: 'agentMessage', id: 'answer', text: 'Answer' },
    ];
    const turn = { id: 'turn_1', status: 'completed', items };
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: { id: 'thr_existing', modelProvider: 'openai', turns: [turn] },
    });
    api.selectModel('other/different-model');
    for (const item of items)
      mock.emit({
        method: 'item/completed',
        params: { threadId: 'thr_existing', turnId: 'turn_1', item },
      });
    const expectedModel = { providerID: 'codex', modelID: 'gpt-6-astra' };
    expect(
      api.realtimeHistoryQueue.value.find((entry) => entry.info.role === 'user')?.info,
    ).toMatchObject({ model: expectedModel });
    expect(
      api.realtimeHistoryQueue.value.find((entry) => entry.info.role === 'assistant')?.info,
    ).toMatchObject(expectedModel);
    api.selectModel('');
    mock.emit({ method: 'turn/completed', params: { threadId: 'thr_existing', turn } });
    await vi.waitFor(() =>
      expect(
        api.canonicalHistory.value.find((entry) => entry.info.role === 'user')?.info,
      ).toMatchObject({ model: expectedModel }),
    );
    api.disconnect();
    const fresh = useCodexApi({ adapterFactory: () => mock.adapter });
    await fresh.connect();
    await fresh.selectThread('thr_existing');
    expect(
      fresh.canonicalHistory.value.find((entry) => entry.info.role === 'user')?.info,
    ).toMatchObject({ model: expectedModel, variant: 'medium' });
    expect(
      fresh.canonicalHistory.value.find((entry) => entry.info.role === 'assistant')?.info,
    ).toMatchObject(expectedModel);
    const childHistory = await fresh.readSubagentHistory('thr_existing');
    expect(childHistory.find((entry) => entry.info.role === 'assistant')?.info).toMatchObject(
      expectedModel,
    );
  });

  it.each(['before', 'after'] as const)(
    'retains a plan mode when the server echo arrives %s acknowledgement',
    async (echoTiming) => {
      const mock = createAdapterMock();
      const reply = deferred<CodexPromptResult>();
      mock.adapter.sendPrompt = vi.fn(() => reply.promise);
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      const sending = api.sendPrompt('Explain', {
        collaborationMode: {
          mode: 'plan',
          settings: { model: 'gpt-6-astra', developer_instructions: null },
        },
      });
      const clientId = vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId;
      expect(
        api.realtimeHistoryQueue.value.find((entry) => entry.info.role === 'user')?.info.agent,
      ).toBe('plan');
      if (echoTiming === 'after') {
        reply.resolve({
          threadId: 'thr_existing',
          turn: { id: 'turn_mode', status: 'inProgress' },
        });
        await sending;
      }
      mock.emit({
        method: 'item/completed',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_mode',
          item: {
            type: 'userMessage',
            id: 'u',
            clientId,
            content: [{ type: 'text', text: 'Explain' }],
          },
        },
      });
      expect(
        api.realtimeHistoryQueue.value
          .filter((entry) => entry.info.role === 'user')
          .map((entry) => entry.info.agent),
      ).toEqual(['plan']);
      mock.emit({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thr_existing', turnId: 'turn_mode', itemId: 'a', delta: 'Answer' },
      });
      expect(api.realtimeStreamingPart.value?.info).toMatchObject({ agent: 'plan', mode: 'codex' });
      if (echoTiming === 'before') {
        reply.resolve({
          threadId: 'thr_existing',
          turn: { id: 'turn_mode', status: 'inProgress' },
        });
        await sending;
      }
      mock.emit({
        method: 'item/completed',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_mode',
          item: { type: 'agentMessage', id: 'a', text: 'Answer' },
        },
      });
      expect(api.realtimeHistoryQueue.value.map((entry) => entry.info.agent)).toEqual([
        'plan',
        'plan',
      ]);
      api.disconnect();
    },
  );

  it('restores plan and default prompts in a shared turn without relabelling unknown history', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Plan', {
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'gpt-6-astra', developer_instructions: null },
      },
    });
    const planClient = vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId;
    await api.sendPrompt('Implement');
    const defaultClient = vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId;
    vi.mocked(mock.adapter.readThread).mockResolvedValue({
      thread: {
        id: 'thr_existing',
        name: 'Existing',
        turns: [
          {
            id: 'turn_1',
            items: [
              {
                type: 'userMessage',
                id: 'p',
                clientId: planClient,
                content: [{ type: 'text', text: 'Plan' }],
              },
              { type: 'agentMessage', id: 'pa', text: 'Plan answer' },
              {
                type: 'userMessage',
                id: 'd',
                clientId: defaultClient,
                content: [{ type: 'text', text: 'Implement' }],
              },
              { type: 'agentMessage', id: 'da', text: 'Implementation answer' },
            ],
          },
          {
            id: 'unknown',
            items: [
              { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Legacy' }] },
              { type: 'agentMessage', id: 'a', text: 'Legacy answer' },
            ],
          },
        ],
      },
    });
    api.disconnect();
    const restored = useCodexApi({ adapterFactory: () => mock.adapter });
    await restored.connect();
    await restored.selectThread('thr_existing');
    expect(restored.canonicalHistory.value.map((entry) => entry.info.agent)).toEqual([
      'plan',
      'plan',
      'default',
      'default',
      'codex',
      'codex',
    ]);
    restored.disconnect();
  });

  it('retains selected effort through the pending prompt and server echo', async () => {
    const mock = createAdapterMock();
    const reply = deferred<CodexPromptResult>();
    mock.adapter.sendPrompt = vi.fn(() => reply.promise);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const sending = api.sendPrompt('Explain', { effort: 'high' });
    const clientId = vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId;
    expect(
      api.realtimeHistoryQueue.value.find((entry) => entry.info.role === 'user')?.info.variant,
    ).toBe('high');
    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_effort',
        item: {
          type: 'userMessage',
          id: 'u',
          clientId,
          content: [{ type: 'text', text: 'Explain' }],
        },
      },
    });
    reply.resolve({ threadId: 'thr_existing', turn: { id: 'turn_effort', status: 'inProgress' } });
    await sending;
    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_effort',
        item: { type: 'agentMessage', id: 'a', text: 'Answer' },
      },
    });
    const messages = api.realtimeHistoryQueue.value.map((entry) => entry.info);
    expect(messages.filter((info) => info.role === 'user')).toHaveLength(1);
    expect(messages.every((info) => info.variant === 'high')).toBe(true);
  });

  it('restores each captured turn effort after reload without labelling unknown turns', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const clientIds = new Map<string, string | undefined>();
    for (const [id, effort] of [
      ['turn_high', 'high'],
      ['turn_low', 'low'],
    ]) {
      vi.mocked(mock.adapter.sendPrompt).mockResolvedValueOnce({
        threadId: 'thr_existing',
        turn: { id, status: 'inProgress' },
      });
      await api.sendPrompt('Explain', { effort });
      clientIds.set(id, vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId);
    }
    vi.mocked(mock.adapter.readThread).mockResolvedValue({
      thread: {
        id: 'thr_existing',
        name: 'Existing',
        turns: ['turn_high', 'turn_low', 'turn_unknown'].map((id) => ({
          id,
          items: [
            {
              type: 'userMessage',
              id: 'u',
              clientId: clientIds.get(id),
              content: [{ type: 'text', text: 'Explain' }],
            },
            { type: 'agentMessage', id: 'a', text: 'Answer' },
          ],
        })),
      },
    });
    api.disconnect();
    const restored = useCodexApi({ adapterFactory: () => mock.adapter });
    await restored.connect();
    await restored.selectThread('thr_existing');
    expect(restored.canonicalHistory.value.map((entry) => entry.info.variant)).toEqual([
      'high',
      'high',
      'low',
      'low',
      undefined,
      undefined,
    ]);
    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_high',
        item: {
          type: 'userMessage',
          id: 'u',
          clientId: clientIds.get('turn_high'),
          content: [{ type: 'text', text: 'Explain' }],
        },
      },
    });
    expect(
      restored.realtimeHistoryQueue.value.find(
        (entry) => entry.info.id === `turn_high:user:${clientIds.get('turn_high')}`,
      )?.info.variant,
    ).toBe('high');
  });

  it('sends only the Codex model id when the selected UI key includes a provider', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    api.selectModel('omniroute/mimo/mimo-v2.5');
    await api.sendPrompt('Hello custom model.', { threadId: 'thr_existing' });

    expect(mock.adapter.sendPrompt).toHaveBeenLastCalledWith({
      summary: 'auto',
      clientUserMessageId: expect.stringMatching(/^client-user:/u),
      text: 'Hello custom model.',
      threadId: 'thr_existing',
      model: 'mimo/mimo-v2.5',
    });
  });

  it('keeps slash-containing explicit Codex model ids intact', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    api.selectModel('omniroute/mimo/mimo-v2.5');
    await api.sendPrompt('Hello explicit custom model.', {
      threadId: 'thr_existing',
      model: 'mimo/mimo-v2.5',
    });

    expect(mock.adapter.sendPrompt).toHaveBeenLastCalledWith({
      summary: 'auto',
      clientUserMessageId: expect.stringMatching(/^client-user:/u),
      text: 'Hello explicit custom model.',
      threadId: 'thr_existing',
      model: 'mimo/mimo-v2.5',
    });
  });

  it('starts threads with the bare Codex model id from the selected UI key', async () => {
    const mock = createAdapterMock();
    mock.adapter.startThread = vi
      .fn()
      .mockResolvedValue({ thread: { id: 'thr_new', preview: '' } });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    api.homeDir.value = '/home/codex';

    await api.connect();
    api.selectModel('omniroute/mimo/mimo-v2.5');
    await api.startThread('~/repo');

    expect(mock.adapter.startThread).toHaveBeenCalledWith({
      cwd: '/home/codex/repo',
      model: 'mimo/mimo-v2.5',
    });
  });
});
