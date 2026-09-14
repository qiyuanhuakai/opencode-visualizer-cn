import { describe, expect, it } from 'vitest';

import { initializeAdapterWithOptions, MockAcpWebSocket, sent } from './acpTestHarness';

const sessionConfigOptions = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'model-a',
    options: [
      { value: 'model-a', name: 'Model A' },
      { value: 'model-b', name: 'Model B' },
    ],
  },
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'plan', name: 'Plan' },
    ],
  },
  {
    id: 'thinking',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: 'off',
    options: [
      { value: 'off', name: 'Off' },
      { value: 'high', name: 'High' },
    ],
  },
];

async function initializeConfigAdapter() {
  return initializeAdapterWithOptions({
    url: 'ws://localhost/acp/test',
    agentId: 'test',
  });
}

async function createConfigSession(
  adapter: Awaited<ReturnType<typeof initializeConfigAdapter>>['adapter'],
  socket: MockAcpWebSocket,
) {
  const creating = adapter.createSession('/workspace');
  await expect.poll(() => socket.sent.length).toBe(2);
  socket.receive({
    jsonrpc: '2.0',
    id: 2,
    result: { sessionId: 'session-1', configOptions: sessionConfigOptions },
  });
  await creating;
}

async function expectConfigSync(socket: MockAcpWebSocket) {
  const expected = [
    { id: 3, params: { sessionId: 'session-1', configId: 'model', value: 'model-b' } },
    { id: 4, params: { sessionId: 'session-1', configId: 'mode', value: 'plan' } },
    { id: 5, params: { sessionId: 'session-1', configId: 'thinking', value: 'high' } },
  ];
  for (const item of expected) {
    await expect.poll(() => socket.sent.length).toBe(item.id);
    expect(sent(socket, item.id - 1)).toEqual({
      jsonrpc: '2.0',
      id: item.id,
      method: 'session/set_config_option',
      params: item.params,
    });
    socket.receive({ jsonrpc: '2.0', id: item.id, result: {} });
  }
}

describe('ACP config synchronization', () => {
  it('applies model, mode, and thought-level selections before prompting', async () => {
    const { adapter, socket } = await initializeConfigAdapter();
    await createConfigSession(adapter, socket);

    const prompting = adapter.sendPromptAsync('session-1', {
      directory: '/workspace',
      agent: 'plan',
      model: { providerID: 'acp', modelID: 'model-b' },
      variant: 'high',
      parts: [{ type: 'text', text: 'hello' }],
    });
    await expectConfigSync(socket);
    await expect.poll(() => socket.sent.length).toBe(6);
    expect(sent(socket, 5)).toEqual(expect.objectContaining({ method: 'session/prompt' }));
    socket.receive({ jsonrpc: '2.0', id: 6, result: { stopReason: 'end_turn' } });
    await prompting;
  });

  it('syncSessionConfig immediately pushes selection changes to the agent outside prompting', async () => {
    const { adapter, socket } = await initializeConfigAdapter();
    await createConfigSession(adapter, socket);

    const syncing = adapter.syncSessionConfig('session-1', {
      model: 'model-b',
      mode: 'plan',
      thoughtLevel: 'high',
    });
    await expectConfigSync(socket);
    await syncing;

    // Local config options reflect the synced values so re-hydration is a no-op.
    const options = adapter.getSessionConfigOptions() as Array<{ id: string; currentValue: string }>;
    expect(options.find((option) => option.id === 'model')?.currentValue).toBe('model-b');
    expect(options.find((option) => option.id === 'mode')?.currentValue).toBe('plan');
    expect(options.find((option) => option.id === 'thinking')?.currentValue).toBe('high');
  });
});
