import { describe, expect, it } from 'vitest';
import type { AcpClientEvent } from './acpClient';
import { initializeAdapter, initializeAdapterWithOptions } from './acpTestHarness';
import { createAcpAttributionStore } from './attributionStore';

const MODEL_CONFIG = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'step-plan/step-3.5-flash',
    options: [{ value: 'step-plan/step-3.5-flash', name: 'step-3.5-flash' }],
  },
];

function updateNotification(sessionId: string, update: Record<string, unknown>) {
  return { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } };
}

async function waitForSent(socket: { sent: string[] }, count: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (socket.sent.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${count} sent messages, saw ${socket.sent.length}`);
}

describe('ACP replay attribution and replay flags', () => {
  it('re-attributes entries when config arrives after replay and flags non-prompt events as replay', async () => {
    const { adapter, socket } = await initializeAdapter();
    const events: AcpClientEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    const loading = adapter.listSessionMessages('s1', { directory: '/w' });
    await waitForSent(socket, 2);
    // Real OMP behavior: replay notifications arrive BEFORE the session/load result.
    socket.receive(updateNotification('s1', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q' }, messageId: 'm1' }));
    socket.receive(updateNotification('s1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' }, messageId: 'm2' }));
    socket.receive({ jsonrpc: '2.0', id: 2, result: { configOptions: MODEL_CONFIG } });
    const entries = await loading;
    // Real OMP behavior: some replay notifications arrive AFTER the load promise resolved.
    socket.receive(updateNotification('s1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' late' }, messageId: 'm2' }));

    const user = entries.find((entry) => entry.info.role === 'user');
    if (user?.info.role !== 'user') throw new Error('Expected user entry');
    expect(user.info.model.modelID).toBe('step-plan/step-3.5-flash');

    const prompting = adapter.sendPromptAsync('s1', {
      directory: '/w',
      agent: 'default',
      model: { modelID: 'default' },
      parts: [{ type: 'text', text: 'hi' }],
    });
    await waitForSent(socket, 3);
    socket.receive(updateNotification('s1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live' }, messageId: 'm3' }));
    socket.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
    await prompting;

    const partEvents = events.filter((event) => event.type === 'message.part.updated');
    expect(partEvents.some((event) => event.replay !== true)).toBe(true);
    expect(partEvents.some((event) => event.replay === true)).toBe(true);

    // The straggler must be flagged replay even though it arrived after the load promise resolved.
    const stragglers = partEvents.filter(
      (event) => event.part.type === 'text' && String(event.part.text).includes('late'),
    );
    expect(stragglers.length).toBeGreaterThan(0);
    for (const event of stragglers) expect(event.replay).toBe(true);

    // Live prompt chunks are never flagged as replay.
    const liveChunks = partEvents.filter(
      (event) => event.part.type === 'text' && String(event.part.text).includes('live'),
    );
    expect(liveChunks.length).toBeGreaterThan(0);
    for (const event of liveChunks) expect(event.replay).not.toBe(true);
  });

  it('restores recorded agent/model/created after a reload instead of config fallback and load time', async () => {
    // Shared attribution store simulating localStorage across a page reload.
    const storeData = { sessions: {} as Record<string, { entries: Record<string, { agent?: string; modelID?: string; created?: number; completed?: number }>; updatedAt: number }> };
    const store = createAcpAttributionStore({
      read: () => storeData,
      write: (data) => {
        Object.assign(storeData, data);
      },
      now: () => 1,
    });

    // --- Live session (before reload): prompt with non-default agent/model. ---
    const live = await initializeAdapterWithOptions({ attributionStore: store });
    const creating = live.adapter.createSession('/w');
    await waitForSent(live.socket, 2);
    live.socket.receive({
      jsonrpc: '2.0',
      id: 2,
      result: {
        sessionId: 's1',
        configOptions: [
          { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'model-a', options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }] },
          { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
        ],
      },
    });
    await creating;

    const prompting = live.adapter.sendPromptAsync('s1', {
      directory: '/w',
      agent: 'plan',
      model: { modelID: 'model-b' },
      parts: [{ type: 'text', text: 'hello' }],
    });
    // Config sync requests (model, mode) then prompt.
    await waitForSent(live.socket, 3);
    live.socket.receive({ jsonrpc: '2.0', id: 3, result: {} });
    await waitForSent(live.socket, 4);
    live.socket.receive({ jsonrpc: '2.0', id: 4, result: {} });
    await waitForSent(live.socket, 5);
    live.socket.receive({ jsonrpc: '2.0', id: 5, result: { stopReason: 'end_turn' } });
    await prompting;
    live.adapter.disconnect();

    // --- After reload: fresh client, same store. OMP reverts mode server-side. ---
    const reloaded = await initializeAdapterWithOptions({
      attributionStore: store,
      now: () => 1_700_000_500_000,
    });
    const loading = reloaded.adapter.listSessionMessages('s1', { directory: '/w' });
    await waitForSent(reloaded.socket, 2);
    reloaded.socket.receive(updateNotification('s1', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } }));
    reloaded.socket.receive(updateNotification('s1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } }));
    reloaded.socket.receive({
      jsonrpc: '2.0',
      id: 2,
      result: {
        configOptions: [
          { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'model-b', options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }] },
          { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
        ],
      },
    });
    const entries = await loading;

    const user = entries.find((entry) => entry.info.role === 'user');
    const assistant = entries.find((entry) => entry.info.role === 'assistant');
    if (user?.info.role !== 'user' || assistant?.info.role !== 'assistant') {
      throw new Error('Expected user and assistant entries');
    }
    // Attribution recorded live wins over the reloaded server config (mode reverted to default).
    expect(user.info.agent).toBe('plan');
    expect(user.info.model.modelID).toBe('model-b');
    expect(user.info.time.created).toBe(1_700_000_000_000);
    expect(assistant.info.agent).toBe('plan');
    expect(assistant.info.mode).toBe('plan');
    expect(assistant.info.time.created).not.toBe(1_700_000_500_000);
    reloaded.adapter.disconnect();
  });


  it('backfills entries without local records from the session meta fetcher', async () => {
    const reloaded = await initializeAdapterWithOptions({
      now: () => 1_700_000_500_000,
      sessionMetaFetcher: async () => [
        { userText: 'hello', userTime: 1_600_000_000_000, assistantTime: 1_600_000_005_000, model: 'model-b', agent: 'plan' },
      ],
    });
    const loading = reloaded.adapter.listSessionMessages('s1', { directory: '/w' });
    await waitForSent(reloaded.socket, 2);
    reloaded.socket.receive(updateNotification('s1', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } }));
    reloaded.socket.receive(updateNotification('s1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } }));
    reloaded.socket.receive({
      jsonrpc: '2.0',
      id: 2,
      result: {
        configOptions: [
          { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'model-a', options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }] },
          { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
        ],
      },
    });
    const entries = await loading;

    const user = entries.find((entry) => entry.info.role === 'user');
    const assistant = entries.find((entry) => entry.info.role === 'assistant');
    if (user?.info.role !== 'user' || assistant?.info.role !== 'assistant') {
      throw new Error('Expected user and assistant entries');
    }
    // No local records: storage meta overrides the config fallback and load time.
    expect(user.info.agent).toBe('plan');
    expect(user.info.model.modelID).toBe('model-b');
    expect(user.info.time.created).toBe(1_600_000_000_000);
    expect(assistant.info.agent).toBe('plan');
    expect(assistant.info.time.completed).toBe(1_600_000_005_000);
    reloaded.adapter.disconnect();
  });
});