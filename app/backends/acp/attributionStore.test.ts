import { describe, expect, it } from 'vitest';
import {
  createAcpAttributionStore,
  type AcpAttributionData,
} from './attributionStore';

function createMemoryBackend(initial: AcpAttributionData = { sessions: {} }) {
  let data = initial;
  return {
    read: () => data,
    write: (next: AcpAttributionData) => {
      data = next;
    },
    current: () => data,
  };
}

describe('createAcpAttributionStore', () => {
  it('round-trips entry attribution per session', () => {
    const backend = createMemoryBackend();
    const store = createAcpAttributionStore({ read: backend.read, write: backend.write, now: () => 1000 });

    store.set('s1', 'acp:s1:user:1', { agent: 'plan', modelID: 'model-b', created: 42 });
    store.set('s1', 'acp:s1:assistant:1', { agent: 'plan', modelID: 'model-b', created: 43 });

    expect(store.get('s1')).toEqual({
      'acp:s1:user:1': { agent: 'plan', modelID: 'model-b', created: 42 },
      'acp:s1:assistant:1': { agent: 'plan', modelID: 'model-b', created: 43 },
    });
    expect(store.get('unknown')).toEqual({});
  });

  it('merges later partial writes for the same entry', () => {
    const backend = createMemoryBackend();
    const store = createAcpAttributionStore({ read: backend.read, write: backend.write, now: () => 1000 });

    store.set('s1', 'acp:s1:assistant:1', { agent: 'default', created: 43 });
    store.set('s1', 'acp:s1:assistant:1', { completed: 99 });

    expect(store.get('s1')['acp:s1:assistant:1']).toEqual({ agent: 'default', created: 43, completed: 99 });
  });

  it('evicts least-recently-used sessions beyond the cap', () => {
    const backend = createMemoryBackend();
    let tick = 0;
    const store = createAcpAttributionStore({ read: backend.read, write: backend.write, now: () => ++tick });

    for (let index = 0; index < 31; index += 1) {
      store.set(`session-${index}`, 'entry', { created: index });
    }

    const sessions = Object.keys(backend.current().sessions);
    expect(sessions).toHaveLength(30);
    expect(sessions).not.toContain('session-0');
    expect(sessions).toContain('session-30');
  });

  it('caps entries per session', () => {
    const backend = createMemoryBackend();
    const store = createAcpAttributionStore({ read: backend.read, write: backend.write, now: () => 1000 });

    for (let index = 0; index < 501; index += 1) {
      store.set('s1', `entry-${index}`, { created: index });
    }

    const entries = Object.keys(store.get('s1'));
    expect(entries).toHaveLength(500);
    expect(entries).not.toContain('entry-0');
    expect(entries).toContain('entry-500');
  });

  it('tolerates corrupt stored data', () => {
    const store = createAcpAttributionStore({
      read: () => null,
      write: () => {},
      now: () => 1000,
    });
    expect(store.get('s1')).toEqual({});
  });
});
