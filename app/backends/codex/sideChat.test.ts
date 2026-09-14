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
