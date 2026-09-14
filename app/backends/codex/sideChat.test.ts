import { describe, expect, it, vi } from 'vitest';
import { createCodexSideChat } from './sideChat';

describe('Codex side chat', () => {
  it('forks ephemerally and routes side output without consuming main output', async () => {
    const adapter = {
      forkThread: vi.fn(async () => ({ thread: { id: 'side' } })),
      startTurn: vi.fn(async () => ({ turn: { id: 'turn', status: 'inProgress' } })),
      interruptTurn: vi.fn(async () => ({})), unsubscribeThread: vi.fn(async () => ({})),
    };
    const controller = createCodexSideChat(() => adapter);
    await controller.startSideChat('main');
    await controller.sendSidePrompt('question');
    expect(adapter.forkThread).toHaveBeenCalledWith({ threadId: 'main', ephemeral: true, excludeTurns: true });
    expect(controller.handleNotification({ method: 'item/agentMessage/delta', params: { threadId: 'main', itemId: 'main-item', delta: 'main' } })).toBe(false);
    expect(controller.handleNotification({ method: 'item/agentMessage/delta', params: { threadId: 'side', itemId: 'answer', delta: 'side answer' } })).toBe(true);
    expect(controller.sideChat.value?.messages.at(-1)?.text).toBe('side answer');
    await controller.closeSideChat();
    expect(adapter.interruptTurn).toHaveBeenCalledWith({ threadId: 'side', turnId: 'turn' });
    expect(adapter.unsubscribeThread).toHaveBeenCalledWith({ threadId: 'side' });
    expect(controller.sideChat.value).toBeNull();
  });
});

it('interrupts only the side turn when close races with its start response', async () => {
  let resolveTurn: (value: { turn: { id: string; status: string } }) => void = () => {};
  const turn = new Promise<{ turn: { id: string; status: string } }>((resolve) => { resolveTurn = resolve; });
  const adapter = {
    forkThread: vi.fn(async () => ({ thread: { id: 'side' } })),
    startTurn: vi.fn(() => turn), interruptTurn: vi.fn(async () => ({})), unsubscribeThread: vi.fn(async () => ({})),
  };
  const controller = createCodexSideChat(() => adapter);
  await controller.startSideChat('main');
  const pending = controller.sendSidePrompt('question');
  await controller.closeSideChat();
  resolveTurn({ turn: { id: 'late-turn', status: 'inProgress' } });
  await pending;
  expect(adapter.interruptTurn).toHaveBeenCalledWith({ threadId: 'side', turnId: 'late-turn' });
  expect(controller.sideChat.value).toBeNull();
});

it('unsubscribes and suppresses closed notifications when interruption fails', async () => {
  // Given a side turn whose interrupt races with completion.
  const adapter = {
    forkThread: vi.fn(async () => ({ thread: { id: 'side' } })),
    startTurn: vi.fn(async () => ({ turn: { id: 'turn', status: 'inProgress' } })),
    interruptTurn: vi.fn().mockRejectedValue(new Error('Turn is no longer running')),
    unsubscribeThread: vi.fn(async () => ({})),
  };
  const controller = createCodexSideChat(() => adapter);
  await controller.startSideChat('main');
  await controller.sendSidePrompt('question');
  // When closing encounters the interrupt failure.
  await expect(controller.closeSideChat()).rejects.toThrow('Turn is no longer running');
  // Then the subscription is still released and late events remain isolated.
  expect(adapter.unsubscribeThread).toHaveBeenCalledWith({ threadId: 'side' });
  expect(controller.sideChat.value).toBeNull();
  expect(controller.handleNotification({ method: 'turn/completed', params: { threadId: 'side', turn: { id: 'turn' } } })).toBe(true);
  await controller.closeSideChat();
  expect(adapter.unsubscribeThread).toHaveBeenCalledTimes(1);
});

it('retries failed unsubscribe after the side panel is closed', async () => {
  // Given a side subscription that cannot be released on the first attempt.
  const adapter = {
    forkThread: vi.fn(async () => ({ thread: { id: 'side' } })),
    startTurn: vi.fn(async () => ({ turn: { id: 'turn', status: 'completed' } })),
    interruptTurn: vi.fn(async () => ({})),
    unsubscribeThread: vi.fn().mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValue({}),
  };
  const controller = createCodexSideChat(() => adapter);
  await controller.startSideChat('main');
  await expect(controller.closeSideChat()).rejects.toThrow('Disconnected');
  // When close is retried.
  await controller.closeSideChat();
  // Then cleanup retries even though the panel is already hidden.
  expect(adapter.unsubscribeThread).toHaveBeenCalledTimes(2);
  expect(controller.sideChat.value).toBeNull();
});
