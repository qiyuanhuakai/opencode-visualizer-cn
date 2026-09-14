import { afterEach, expect, it } from 'vitest';
import { createCodexAdapter } from './codexAdapter';
import { closeCodexTestSockets, CodexTestSocket, waitForSent } from './codexTestSocket';

afterEach(closeCodexTestSockets);
it.each([undefined, 'existing'])('sends explicit standard tier and permission policy for thread %s', async (threadId) => {
  CodexTestSocket.instances = [];
  const adapter = createCodexAdapter({ url: 'ws://localhost:4500', webSocketCtor: CodexTestSocket });
  const pending = adapter.sendPrompt({
    threadId, text: 'hello', serviceTier: 'default', approvalPolicy: 'on-request',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    thread: { sandbox: 'read-only' },
  });
  const socket = CodexTestSocket.instances[0];
  if (!socket) throw new Error('Expected adapter socket');
  socket.emitOpen();
  await waitForSent(socket, 1);
  socket.respond(1, {});
  await waitForSent(socket, 3);
  socket.respond(2, { thread: { id: threadId ?? 'new' } });
  await waitForSent(socket, 4);
  socket.respond(3, { turn: { id: 'turn', status: 'inProgress' } });
  await pending;
  expect(JSON.parse(socket.sent[2] ?? '{}')).toMatchObject({
    method: threadId ? 'thread/resume' : 'thread/start',
    params: { approvalPolicy: 'on-request', sandbox: 'read-only' },
  });
  expect(JSON.parse(socket.sent[3] ?? '{}')).toMatchObject({
    method: 'turn/start', params: { serviceTier: 'default', approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } },
  });
});
