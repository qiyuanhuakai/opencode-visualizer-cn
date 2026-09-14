import { ref } from 'vue';
import type { CodexAdapter, CodexPromptInput } from './codexAdapter';
import type { CodexJsonRpcNotification } from './jsonRpcClient';

type SideMessage = { id: string; role: 'user' | 'assistant'; text: string };
export type CodexSideChat = {
  threadId: string;
  parentThreadId: string;
  messages: SideMessage[];
  pending: boolean;
  error: string;
  turnId: string;
};
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createCodexSideChat(getAdapter: () => Pick<CodexAdapter, 'forkThread' | 'startTurn' | 'interruptTurn' | 'unsubscribeThread'> | null) {
  const sideChat = ref<(CodexSideChat & { settings: Omit<CodexPromptInput, 'text'> }) | null>(null);
  const sideThreadIds = new Set<string>();
  const pendingUnsubscribes = new Map<string, NonNullable<ReturnType<typeof getAdapter>>>();
  let generation = 0;
  async function unsubscribe(threadId: string, adapter: NonNullable<ReturnType<typeof getAdapter>>) {
    pendingUnsubscribes.set(threadId, adapter);
    await adapter.unsubscribeThread({ threadId });
    pendingUnsubscribes.delete(threadId);
  }
  async function closeSideChat() {
    const state = sideChat.value;
    generation += 1;
    sideChat.value = null;
    const adapter = getAdapter();
    if (state && adapter) pendingUnsubscribes.set(state.threadId, adapter);
    try {
      if (state?.pending && state.turnId && adapter) {
        await adapter.interruptTurn({ threadId: state.threadId, turnId: state.turnId });
      }
    } finally {
      for (const [threadId, owner] of pendingUnsubscribes) await unsubscribe(threadId, owner);
    }
  }
  async function sendSidePrompt(text: string) {
    const state = sideChat.value;
    const adapter = getAdapter();
    if (!state || !adapter) throw new Error('请先打开侧聊。');
    const settings = state.settings;
    if (state.pending) throw new Error('侧聊正在运行，请等待完成。');
    if (!text.trim()) return;
    state.messages.push({ id: `user:${Date.now()}`, role: 'user', text: text.trim() });
    state.pending = true;
    state.turnId = '';
    state.error = '';
    try {
      const result = await adapter.startTurn({
        model: settings.model,
        serviceTier: settings.serviceTier,
        approvalPolicy: settings.approvalPolicy,
        sandboxPolicy: settings.sandboxPolicy,
        effort: settings.effort,
        threadId: state.threadId, input: [{ type: 'text', text: text.trim() }],
      });
      state.turnId = result.turn.id;
      if (['completed', 'failed', 'interrupted'].includes(result.turn.status ?? '')) state.pending = false;
      if (sideChat.value !== state && state.pending) {
        await adapter.interruptTurn({ threadId: state.threadId, turnId: result.turn.id });
      }
    } catch (error) {
      state.pending = false;
      state.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
  async function startSideChat(parentThreadId: string, settings: Omit<CodexPromptInput, 'text'> = {}) {
    if (!parentThreadId) throw new Error('请先开始一个主会话。');
    await closeSideChat();
    const adapter = getAdapter();
    if (!adapter) throw new Error('Codex is not connected.');
    const currentGeneration = generation;
    const result = await adapter.forkThread({ threadId: parentThreadId, ephemeral: true, excludeTurns: true });
    sideThreadIds.add(result.thread.id);
    if (currentGeneration !== generation) {
      await unsubscribe(result.thread.id, adapter);
      return;
    }
    sideChat.value = { threadId: result.thread.id, parentThreadId, settings, messages: [], pending: false, error: '', turnId: '' };
  }
  function handleNotification(notification: CodexJsonRpcNotification) {
    if (notification.method === 'serverRequest/resolved') return false;
    const params = record(notification.params) ? notification.params : {};
    const thread = record(params.thread) ? params.thread : null;
    if (thread?.ephemeral === true && typeof thread.id === 'string') sideThreadIds.add(thread.id);
    const threadId = typeof params.threadId === 'string' ? params.threadId : thread?.id;
    if (typeof threadId !== 'string' || !sideThreadIds.has(threadId)) return false;
    const state = sideChat.value;
    if (!state || state.threadId !== threadId) return true;
    const turn = record(params.turn) ? params.turn : null;
    if (turn && typeof turn.id === 'string') state.turnId = turn.id;
    if (notification.method === 'turn/completed') {
      state.pending = false;
      if (turn?.error) state.error = record(turn.error) && typeof turn.error.message === 'string' ? turn.error.message : '侧聊运行失败';
    }
    if (notification.method === 'error') {
      const error = record(params.error) ? params.error : {};
      state.error = typeof error.message === 'string' ? error.message : '侧聊运行失败';
      if (params.willRetry !== true) state.pending = false;
    }
    if (notification.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      const id = typeof params.itemId === 'string' ? params.itemId : state.turnId;
      const message = state.messages.find((entry) => entry.id === id);
      if (message) message.text += params.delta;
      else state.messages.push({ id, role: 'assistant', text: params.delta });
    }
    if (notification.method === 'item/completed' && record(params.item) && params.item.type === 'agentMessage' && typeof params.item.text === 'string') {
      const id = typeof params.item.id === 'string' ? params.item.id : state.turnId;
      const message = state.messages.find((entry) => entry.id === id);
      if (message) message.text = params.item.text;
      else state.messages.push({ id, role: 'assistant', text: params.item.text });
    }
    return true;
  }
  function reset() { generation += 1; sideChat.value = null; sideThreadIds.clear(); pendingUnsubscribes.clear(); }
  return { sideChat, startSideChat, sendSidePrompt, closeSideChat, handleNotification, reset };
}
