import { nextTick, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCodexTurnsToHistory } from '../backends/codex/normalize';
import type { BackendKind } from '../backends/types';
import type {
  AssistantMessageInfo,
  MessagePart,
  ReasoningPart,
  ToolPart,
  UserMessageInfo,
} from '../types/sse';
import { useCodexMessageBridge } from './useCodexMessageBridge';

describe('useCodexMessageBridge', () => {
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

    const realtimeHistoryQueue = ref<typeof restored>([]);
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
  });
});
