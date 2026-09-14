import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CodexJsonRpcClient } from '../codex/jsonRpcClient';
import { closeCodexTestSockets, CodexTestSocket as MockWebSocket } from '../codex/codexTestSocket';
import { AcpPermissionStore } from './permissionStore';

function parseSent(index: number) {
  const socket = MockWebSocket.instances[0];
  if (!socket) throw new Error('Expected ACP test socket.');
  const message: unknown = JSON.parse(socket.sent[index] ?? '{}');
  return message;
}

async function createStore() {
  const requests: ReturnType<AcpPermissionStore['list']> = [];
  const client = new CodexJsonRpcClient({
    url: 'ws://localhost:23004/acp/oh-my-pi',
    jsonRpcVersion: '2.0',
    webSocketCtor: MockWebSocket,
  });
  const connecting = client.connect();
  const socket = MockWebSocket.instances[0];
  if (!socket) throw new Error('Expected ACP test socket.');
  socket.open();
  await connecting;
  const store = new AcpPermissionStore(
    client,
    (sessionId) => `assistant:${sessionId}`,
    (request) => {
      requests.push(request);
    },
  );
  return { store, requests };
}

beforeEach(() => {
  MockWebSocket.instances = [];
});

afterEach(() => {
  closeCodexTestSockets();
});

describe('AcpPermissionStore', () => {
  it('offers Always only when ACP includes an allow_always option', async () => {
    // Given: one ACP permission request offers only once/reject and one offers allow_always.
    const { requests, store } = await createStore();

    // When: both server requests enter the real ACP permission store.
    store.handleServerRequest({
      id: 41,
      method: 'session/request_permission',
      params: {
        sessionId: 'session-once',
        toolCall: { toolCallId: 'tool-once', title: 'Run command' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    store.handleServerRequest({
      id: 42,
      method: 'session/request_permission',
      params: {
        sessionId: 'session-always',
        toolCall: { toolCallId: 'tool-always', title: 'Edit file' },
        options: [
          { optionId: 'allow-once-2', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
        ],
      },
    });

    // Then: the UI-facing requests expose Always only for the allow_always request.
    expect(requests).toEqual([
      expect.objectContaining({ id: '41', always: [] }),
      expect.objectContaining({ id: '42', always: ['*'] }),
    ]);
    expect(store.list()).toEqual([
      expect.objectContaining({ id: '41', always: [] }),
      expect.objectContaining({ id: '42', always: ['*'] }),
    ]);
  });

  it('selects the allow_always option when replying Always', async () => {
    // Given: a pending ACP permission request includes an allow_always option.
    const { store } = await createStore();
    store.handleServerRequest({
      id: 77,
      method: 'session/request_permission',
      params: {
        sessionId: 'session-1',
        toolCall: { toolCallId: 'tool-1', title: 'Write file' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
        ],
      },
    });

    // When: the user replies with Always.
    store.reply('77', 'always');

    // Then: the JSON-RPC response selects the ACP allow_always option id.
    expect(parseSent(0)).toEqual({
      jsonrpc: '2.0',
      id: 77,
      result: { outcome: { kind: 'selected', optionId: 'allow-always' } },
    });
    expect(store.list()).toEqual([]);
  });
});
