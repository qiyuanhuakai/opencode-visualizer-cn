import { afterEach, expect, it } from 'vitest';
import { createCodexAdapter } from './codexAdapter';
import { closeCodexTestSockets, CodexTestSocket, waitForSent } from './codexTestSocket';

afterEach(closeCodexTestSockets);

it('sends paginated revert with the first excluded turn, without legacy rollback fields', async () => {
  const adapter = createCodexAdapter({ url: 'ws://localhost:4500', webSocketCtor: CodexTestSocket });
  const revert = adapter.revertThread({ threadId: 'review-thread', beforeTurnId: 'review-turn' });
  const socket = CodexTestSocket.instances.at(-1);
  if (!socket) throw new Error('Expected a transport connection');
  socket.emitOpen();
  await waitForSent(socket, 1);
  socket.respond(1, {});
  await waitForSent(socket, 3);
  expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
    id: 2,
    method: 'thread/revert',
    params: { threadId: 'review-thread', beforeTurnId: 'review-turn' },
  });
  socket.respond(2, { thread: { id: 'review-thread', historyMode: 'paginated', turns: [] } });
  await expect(revert).resolves.toMatchObject({ thread: { id: 'review-thread' } });
});
