import { beforeEach, describe, expect, it } from 'vitest';

import { initializeAdapter, MockAcpWebSocket, sent } from './acpTestHarness';

describe('AcpAdapter', () => {
  beforeEach(() => {
    MockAcpWebSocket.instances = [];
  });

  it('initializes with the live ACP v1 capability envelope', async () => {
    const { adapter, socket } = await initializeAdapter();

    expect(sent(socket, 0)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          auth: { terminal: true },
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: 'vis', title: 'VIS', version: expect.any(String) },
      },
    });
    expect(adapter.agentInfo).toEqual({ name: 'oh-my-pi', title: 'Oh My Pi', version: '14.9.2' });
    expect(adapter.capabilities.providerConfig).toBe(false);
    await expect(adapter.getGlobalConfig()).resolves.toEqual({});
    expect(adapter.supports('session/list')).toBe(true);
    expect(adapter.supports('session/resume')).toBe(false);
  });

  it('creates a session and normalizes streamed messages, reasoning, and tools', async () => {
    const { adapter, socket } = await initializeAdapter();
    const events: unknown[] = [];
    adapter.onEvent((event) => events.push(event));

    const creating = adapter.createSession('/workspace/project');
    await Promise.resolve();
    expect(sent(socket, 1)).toEqual({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: '/workspace/project', mcpServers: [] },
    });
    socket.receive({
      jsonrpc: '2.0',
      id: 2,
      result: {
        sessionId: 'session-1',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'provider/model-a',
            options: [
              { value: 'provider/model-a', name: 'Model A' },
              { value: 'provider/model-b', name: 'Model B' },
            ],
          },
        ],
      },
    });
    await expect(creating).resolves.toEqual(
      expect.objectContaining({
        id: 'session-1',
        directory: '/workspace/project',
        projectID: 'acp',
      }),
    );
    const listProviders = adapter.listProviders;
    await expect(listProviders()).resolves.toEqual(
      expect.objectContaining({
        default: { acp: 'provider/model-a' },
        all: [
          expect.objectContaining({
            models: expect.objectContaining({
              'provider/model-a': expect.objectContaining({ name: 'Model A' }),
              'provider/model-b': expect.objectContaining({ name: 'Model B' }),
            }),
          }),
        ],
      }),
    );

    const prompting = adapter.sendPromptAsync('session-1', {
      directory: '/workspace/project',
      agent: 'default',
      model: { providerID: 'acp', modelID: 'provider/model-a' },
      parts: [{ type: 'text', text: 'Hello' }],
    });
    await expect.poll(() => socket.sent.length).toBe(3);
    expect(sent(socket, 2)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'Hello' }],
      },
    });
    socket.receive({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Thinking' },
        },
      },
    });
    socket.receive({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hi there' },
        },
      },
    });
    socket.receive({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'Read file',
          kind: 'read',
          status: 'in_progress',
          rawInput: { path: '/workspace/project/a.ts' },
        },
      },
    });
    socket.receive({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          status: 'completed',
          rawOutput: 'ok',
        },
      },
    });
    socket.receive({
      jsonrpc: '2.0',
      id: 3,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 120, outputTokens: 8, totalTokens: 128 },
      },
    });
    await prompting;

    const history = await adapter.listSessionMessages('session-1');
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual(
      expect.objectContaining({
        info: expect.objectContaining({ role: 'user', sessionID: 'session-1' }),
        parts: [expect.objectContaining({ type: 'text', text: 'Hello' })],
      }),
    );
    expect(history[1]).toEqual(
      expect.objectContaining({
        info: expect.objectContaining({
          role: 'assistant',
          finish: 'end_turn',
          tokens: expect.objectContaining({ input: 120, output: 8, total: 128 }),
        }),
        parts: expect.arrayContaining([
          expect.objectContaining({ type: 'reasoning', text: 'Thinking' }),
          expect.objectContaining({ type: 'text', text: 'Hi there' }),
          expect.objectContaining({
            type: 'tool',
            callID: 'tool-1',
            state: expect.objectContaining({ status: 'completed' }),
          }),
        ]),
      }),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'message.updated' }),
        expect.objectContaining({ type: 'message.part.updated' }),
      ]),
    );
  });

  it('surfaces permission requests and answers with the matching ACP option', async () => {
    const { adapter, socket } = await initializeAdapter();
    socket.receive({
      jsonrpc: '2.0',
      id: 77,
      method: 'session/request_permission',
      params: {
        sessionId: 'session-1',
        toolCall: { toolCallId: 'tool-1', title: 'Run tests', kind: 'execute' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny-once', name: 'Deny', kind: 'reject_once' },
        ],
      },
    });

    await expect(adapter.listPendingPermissions()).resolves.toEqual([
      expect.objectContaining({
        id: '77',
        sessionID: 'session-1',
        permission: 'Run tests',
        tool: { messageID: 'acp:session-1:assistant', callID: 'tool-1' },
      }),
    ]);
    await adapter.replyPermission('77', { reply: 'once' });
    expect(sent(socket, 1)).toEqual({
      jsonrpc: '2.0',
      id: 77,
      result: { outcome: { kind: 'selected', optionId: 'allow-once' } },
    });
  });
});
