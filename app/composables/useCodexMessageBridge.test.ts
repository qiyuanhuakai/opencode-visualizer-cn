import { nextTick, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCodexTurnsToHistory, type CodexCanonicalHistoryEntry } from '../backends/codex/normalize';
import type { BackendKind } from '../backends/types';
import type {
  AssistantMessageInfo,
  MessagePart,
  ReasoningPart,
  ToolPart,
  UserMessageInfo,
} from '../types/sse';
import { useCodexMessageBridge } from './useCodexMessageBridge';

function bridgeFixture() {
  const params = {
    activeBackendKind: ref<BackendKind>('codex'),
    selectedSessionId: ref('thread-1'),
    codexPendingSessionLock: ref(''),
    history: ref<CodexCanonicalHistoryEntry[]>([]),
    codexApi: {
      realtimeHistoryQueue: ref<CodexCanonicalHistoryEntry[]>([]),
      realtimeMessageAliases: ref<Record<string, string>>({}),
      realtimeStreamingPart: ref<{ info: AssistantMessageInfo | UserMessageInfo; part: MessagePart } | null>(null),
      realtimeReasoningPart: ref<{ info: AssistantMessageInfo | UserMessageInfo; part: ReasoningPart } | null>(null),
      realtimeToolParts: ref<Array<{ info: AssistantMessageInfo | UserMessageInfo; part: ToolPart }>>([]),
      tokenUsage: ref<unknown>(null),
      diffState: ref<{ threadId: string; turnId: string; diff: string } | null>(null),
    },
    msg: { loadHistory: vi.fn(), updateMessage: vi.fn(), updatePart: vi.fn(), removeMessage: vi.fn() },
    syncRealtimeToolWindows: vi.fn(),
    updateReasoningExpiry: vi.fn(),
  };
  useCodexMessageBridge(params);
  return params;
}

function liveHistory() {
  return normalizeCodexTurnsToHistory({
    sessionId: 'thread-1',
    turns: [{ id: 'turn-1', items: [
      { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Inspect' }] },
      { id: 'text', type: 'agentMessage', text: 'Checking files' },
      { id: 'tool-1', type: 'commandExecution', command: 'pwd', status: 'inProgress', aggregatedOutput: '' },
      { id: 'tool-2', type: 'commandExecution', command: 'ls', status: 'inProgress', aggregatedOutput: '' },
    ] }],
  });
}

describe('useCodexMessageBridge', () => {
  it('publishes only the changed tool across queue and tool watchers', async () => {
    const params = bridgeFixture();
    const entries = liveHistory();
    params.codexApi.realtimeHistoryQueue.value = entries;
    await nextTick();
    params.msg.updateMessage.mockClear();
    params.msg.updatePart.mockClear();
    const changed = entries.map(entry => ({ ...entry, parts: entry.parts.map(part =>
      part.type === 'tool' && part.id === 'tool-1' && part.state.status === 'completed'
        ? { ...part, state: { ...part.state, output: '/repo' } }
        : part,
    ) }));
    params.codexApi.realtimeHistoryQueue.value = changed;
    params.codexApi.realtimeToolParts.value = changed.flatMap(entry => entry.parts.flatMap(part =>
      part.type === 'tool' ? [{ info: entry.info, part }] : [],
    ));
    await nextTick();
    expect(params.msg.updateMessage).not.toHaveBeenCalled();
    expect(params.msg.updatePart).toHaveBeenCalledTimes(1);
    expect(params.msg.updatePart).toHaveBeenCalledWith(expect.objectContaining({ id: 'tool-1' }));
  });

  it('forwards parent-only changes without replaying parts', async () => {
    const params = bridgeFixture();
    params.codexApi.realtimeHistoryQueue.value = liveHistory();
    await nextTick();
    params.msg.updateMessage.mockClear();
    params.msg.updatePart.mockClear();
    params.codexApi.realtimeHistoryQueue.value = params.codexApi.realtimeHistoryQueue.value.map(entry => ({
      ...entry,
      info: entry.info.role === 'assistant' ? { ...entry.info, parentID: 'correct-user' } : entry.info,
    }));
    await nextTick();
    expect(params.msg.updateMessage).toHaveBeenCalledTimes(2);
    expect(params.msg.updateMessage.mock.calls.map(([info]) => info.id)).toEqual(
      params.codexApi.realtimeHistoryQueue.value.filter(entry => entry.info.role === 'assistant').map(entry => entry.info.id),
    );
    expect(params.msg.updateMessage).toHaveBeenCalledWith(expect.objectContaining({ parentID: 'correct-user' }));
    expect(params.msg.updatePart).not.toHaveBeenCalled();
  });

  it('shares text deduplication with streaming updates while removing provisional aliases', async () => {
    const params = bridgeFixture();
    const entries = liveHistory();
    params.codexApi.realtimeHistoryQueue.value = entries;
    params.codexApi.realtimeMessageAliases.value = { provisional: 'turn-1:user:0' };
    await nextTick();
    expect(params.msg.removeMessage).toHaveBeenCalledWith('provisional');
    params.msg.updateMessage.mockClear();
    params.msg.updatePart.mockClear();
    const assistant = entries.find(entry => entry.info.role === 'assistant');
    const text = assistant?.parts.find(part => part.type === 'text');
    if (!assistant || !text) throw new Error('Expected assistant text fixture');
    params.codexApi.realtimeStreamingPart.value = { info: assistant.info, part: text };
    await nextTick();
    expect(params.msg.updateMessage).not.toHaveBeenCalled();
    expect(params.msg.updatePart).not.toHaveBeenCalled();
    params.codexApi.realtimeStreamingPart.value = { info: assistant.info, part: { ...text, text: 'Checking more files' } };
    await nextTick();
    expect(params.msg.updateMessage).not.toHaveBeenCalled();
    expect(params.msg.updatePart).toHaveBeenCalledOnce();
  });

  it('seeds live deduplication from loaded history and resets it across sessions and backends', async () => {
    const params = bridgeFixture();
    const entries = liveHistory();
    params.history.value = entries;
    await nextTick();
    params.codexApi.realtimeHistoryQueue.value = entries;
    await nextTick();
    expect(params.msg.loadHistory).toHaveBeenCalledWith(entries);
    expect(params.msg.updateMessage).not.toHaveBeenCalled();
    expect(params.msg.updatePart).not.toHaveBeenCalled();
    params.activeBackendKind.value = 'opencode';
    await nextTick();
    params.activeBackendKind.value = 'codex';
    params.codexApi.realtimeHistoryQueue.value = [];
    await nextTick();
    params.codexApi.realtimeHistoryQueue.value = entries;
    await nextTick();
    expect(params.msg.updatePart).toHaveBeenCalledTimes(entries.flatMap(entry => entry.parts).length);
    params.msg.updatePart.mockClear();
    params.selectedSessionId.value = 'thread-2';
    await nextTick();
    params.selectedSessionId.value = 'thread-1';
    params.codexApi.realtimeHistoryQueue.value = [];
    await nextTick();
    params.codexApi.realtimeHistoryQueue.value = entries;
    await nextTick();
    expect(params.msg.updatePart).toHaveBeenCalledTimes(entries.flatMap(entry => entry.parts).length);
  });
  it('forwards restored reasoning and tool parts to the shared VIS message store', async () => {
    const history = normalizeCodexTurnsToHistory({
      sessionId: 'thread-1',
      turns: [
        {
          id: 'turn-1',
          items: [
            { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Inspect.' }] },
            { id: 'reasoning-1', type: 'reasoning', summary: ['Checking the command'], content: [] },
            {
              id: 'command-1',
              type: 'commandExecution',
              command: 'pwd',
              cwd: '/repo',
              status: 'completed',
              aggregatedOutput: '/repo\n',
            },
            { id: 'agent-1', type: 'agentMessage', text: 'Done.' },
          ],
        },
      ],
    });
    const restored = history
      .filter((entry) => entry.info.role === 'assistant')
      .map((entry) => ({
        info: entry.info,
        parts: entry.parts.filter((part) => part.type === 'reasoning' || part.type === 'tool'),
      }));
    const updatePart = vi.fn<(part: MessagePart) => void>();
    const syncRealtimeToolWindows = vi.fn();

    const realtimeHistoryQueue = ref<CodexCanonicalHistoryEntry[]>([]);
    useCodexMessageBridge({
      activeBackendKind: ref<BackendKind>('codex'),
      selectedSessionId: ref('thread-1'),
      codexPendingSessionLock: ref(''),
      history: ref([]),
      codexApi: {
        realtimeHistoryQueue,
        realtimeMessageAliases: ref({}),
        realtimeStreamingPart: ref<{
          info: AssistantMessageInfo | UserMessageInfo;
          part: MessagePart;
        } | null>(null),
        realtimeReasoningPart: ref<{
          info: AssistantMessageInfo | UserMessageInfo;
          part: ReasoningPart;
        } | null>(null),
        realtimeToolParts: ref<Array<{
          info: AssistantMessageInfo | UserMessageInfo;
          part: ToolPart;
        }>>([]),
        tokenUsage: ref<unknown>(null),
        diffState: ref<{ threadId: string; turnId: string; diff: string } | null>(null),
      },
      msg: {
        loadHistory: vi.fn(),
        updateMessage: vi.fn(),
        updatePart,
        removeMessage: vi.fn(),
      },
      syncRealtimeToolWindows,
      updateReasoningExpiry: vi.fn(),
    });

    realtimeHistoryQueue.value = restored;
    await nextTick();

    expect(updatePart.mock.calls.map(([part]) => part.type)).toEqual(['reasoning', 'tool']);
    expect(syncRealtimeToolWindows).toHaveBeenCalledWith(restored);
    const images = normalizeCodexTurnsToHistory({ sessionId: 'thread-1', turns: [{ id: 'image-turn', items: [{ id: 'shot', type: 'imageView', path: '/tmp/shot.png' }] }] });
    realtimeHistoryQueue.value = images;
    await nextTick();
    updatePart.mockClear();
    realtimeHistoryQueue.value = images.map(entry => ({ ...entry, parts: entry.parts.map(part => part.type === 'file' ? { ...part, url: 'data:image/png;base64,AA==' } : part) }));
    await nextTick();
    expect(updatePart).toHaveBeenCalledWith(expect.objectContaining({ type: 'file', url: 'data:image/png;base64,AA==' }));

  });
});
