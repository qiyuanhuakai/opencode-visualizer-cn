import { describe, expect, it, beforeEach } from 'vitest';
import {
  createAcpAgentList,
  createAcpPermissionModeList,
  createAcpUiModeState,
  resolveAcpModeSelection,
} from './configOptions';
import { initializeAdapter, MockAcpWebSocket, sent } from './acpTestHarness';

const modeConfig = {
  id: 'mode',
  name: 'Mode',
  category: 'mode',
  type: 'select',
  currentValue: 'acceptEdits',
  options: [
    { value: 'normal', name: 'Normal' },
    { value: 'acceptEdits', name: 'Accept Edits' },
    { value: 'plan', name: 'Plan' },
    { value: 'bypassPermissions', name: 'Bypass Permissions' },
  ],
};

describe('ACP mode and command adaptation', () => {
  beforeEach(() => {
    MockAcpWebSocket.instances = [];
  });

  it('separates agent modes from permission policies', () => {
    expect(createAcpAgentList([modeConfig], 'Oh My Pi')).toEqual([
      expect.objectContaining({ name: 'default' }),
      expect.objectContaining({ name: 'plan' }),
    ]);
    expect(createAcpPermissionModeList([modeConfig])).toEqual({
      current: 'acceptEdits',
      options: [
        { id: 'normal', name: 'Normal' },
        { id: 'acceptEdits', name: 'Accept Edits' },
        { id: 'bypassPermissions', name: 'Bypass Permissions' },
      ],
    });
    expect(resolveAcpModeSelection('default', 'bypassPermissions')).toBe('bypassPermissions');
    expect(resolveAcpModeSelection('plan', 'bypassPermissions')).toBe('plan');
    expect(createAcpUiModeState([modeConfig], 'normal')).toEqual({
      agent: 'default',
      permissionMode: 'acceptEdits',
    });
    expect(createAcpUiModeState([{ ...modeConfig, currentValue: 'plan' }], 'acceptEdits')).toEqual({
      agent: 'plan',
      permissionMode: 'acceptEdits',
    });
  });

  it('publishes live slash commands and dispatches them through session/prompt', async () => {
    const { adapter, socket } = await initializeAdapter();
    const creating = adapter.createSession('/workspace');
    await expect.poll(() => socket.sent.length).toBe(2);
    socket.receive({
      jsonrpc: '2.0',
      id: 2,
      result: { sessionId: 'session-1', configOptions: [modeConfig] },
    });
    await creating;
    socket.receive({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'plan', description: 'Create a plan', input: { hint: '<task>' } },
          ],
        },
      },
    });

    await expect(adapter.listCommands?.()).resolves.toEqual([
      { name: 'plan', description: 'Create a plan', input: { hint: '<task>' } },
    ]);
    const sending = adapter.sendCommand?.('session-1', {
      directory: '/workspace',
      command: 'plan',
      arguments: 'inspect auth',
      agent: 'default',
      model: 'default',
    });
    await expect.poll(() => socket.sent.length).toBe(3);
    expect(sent(socket, 2)).toMatchObject({
      method: 'session/prompt',
      params: {
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: '/plan inspect auth' }],
      },
    });
    socket.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
    await sending;
  });

  it('forwards command file parts as prompt content blocks', async () => {
    const { adapter, socket } = await initializeAdapter();
    const creating = adapter.createSession('/workspace');
    await expect.poll(() => socket.sent.length).toBe(2);
    socket.receive({
      jsonrpc: '2.0',
      id: 2,
      result: { sessionId: 'session-1', configOptions: [modeConfig] },
    });
    await creating;

    const sending = adapter.sendCommand?.('session-1', {
      directory: '/workspace',
      command: 'plan',
      arguments: 'inspect auth',
      agent: 'default',
      model: 'default',
      parts: [
        {
          type: 'file',
          mime: 'image/png',
          url: 'data:image/png;base64,AA==',
          filename: 'image.png',
        },
      ],
    });
    await expect.poll(() => socket.sent.length).toBe(3);
    expect(sent(socket, 2)).toMatchObject({
      method: 'session/prompt',
      params: {
        sessionId: 'session-1',
        prompt: [
          { type: 'text', text: '/plan inspect auth' },
          { type: 'image', mimeType: 'image/png', data: 'AA==' },
        ],
      },
    });
    socket.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
    await sending;
  });
});
