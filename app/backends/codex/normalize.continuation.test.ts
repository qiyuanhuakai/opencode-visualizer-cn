import { afterEach, describe, expect, it } from 'vitest';
import { useMessages } from '../../composables/useMessages';
import { normalizeCodexTurnItems, normalizeCodexTurnsToHistory } from './normalize';

const user = (id: string) => ({ id, type: 'userMessage', content: [{ type: 'text', text: id }] });
const reply = (id: string) => ({ id, type: 'agentMessage', text: id });
const command = (id: string) => ({ id, type: 'commandExecution', command: 'ls', status: 'completed' });

afterEach(() => useMessages().reset());

describe('Codex history grouping in the message store', () => {
  it('preserves separate explicit user roots and their chronological tool and answer messages', () => {
    const history = normalizeCodexTurnsToHistory({
      sessionId: 's',
      turns: [
        { id: 't1', createdAt: 100, items: [user('u1'), command('c1'), reply('a1')] },
        { id: 't2', createdAt: 200, items: [user('u2'), reply('a2'), user('u3'), command('c3'), reply('a3')] },
      ],
    });
    const store = useMessages();
    store.loadHistory(history);
    expect(store.roots.value.map((root) => root.id)).toEqual(['t1:user:u1', 't2:user:u2', 't2:user:u3']);
    expect(store.roots.value.map((root) => store.getThread(root.id).map((message) => message.id))).toEqual([
      ['t1:user:u1', 't1:assistant:c1', 't1:assistant:a1'],
      ['t2:user:u2', 't2:assistant:a2'],
      ['t2:user:u3', 't2:assistant:c3', 't2:assistant:a3'],
    ]);
    expect(store.getFinalAnswer('t1:user:u1')?.id).toBe('t1:assistant:a1');
    expect(store.getParts('t1:assistant:c1')).toEqual([expect.objectContaining({ id: 'c1', type: 'tool' })]);
  });

  it('preserves all message and part payloads when assembling indexed history', () => {
    const items = [
      user('u1'),
      { id: 'r1', type: 'reasoning', summary: ['first', 'second'] },
      command('c1'),
      reply('a1'),
      { id: 'compact', type: 'contextCompaction' },
      { id: 'u2', type: 'userMessage', content: [
        { type: 'text', text: 'attached' },
        { type: 'image', url: 'data:image/png;base64,AA==' },
      ] },
      reply('a2'),
    ];
    const bundle = normalizeCodexTurnItems({ sessionId: 's', turnId: 't', createdAt: 100, items });
    const history = normalizeCodexTurnsToHistory({ sessionId: 's', turns: [{ id: 't', createdAt: 100, items }] });
    expect(history).toEqual(bundle.messages.map((info) => ({
      info,
      parts: bundle.parts.filter((part) => part.messageID === info.id),
    })));
    expect(history.find((entry) => entry.info.id === 't:user:u2')?.parts.map((part) => part.type)).toEqual(['text', 'file']);
  });

  it('attaches consecutive userless turns to the latest user until the next explicit user', () => {
    const history = normalizeCodexTurnsToHistory({
      sessionId: 's',
      turns: [
        { id: 't1', createdAt: 100, items: [user('u1'), reply('a1'), user('u2'), reply('a2')] },
        { id: 't2', createdAt: 200, items: [command('c2'), { id: 'r2', type: 'reasoning', summary: ['continued'] }] },
        { id: 't3', createdAt: 300, items: [reply('a3')] },
        { id: 't4', createdAt: 400, items: [command('before-u3'), user('u3'), reply('after-u3')] },
        { id: 't5', createdAt: 500, items: [reply('a5')] },
      ],
    });
    const store = useMessages();
    store.loadHistory(history);
    expect(store.roots.value.map((root) => root.id)).toEqual(['t1:user:u1', 't1:user:u2', 't4:user:u3']);
    expect(store.getThread('t1:user:u2').map((message) => message.id)).toEqual([
      't1:user:u2', 't1:assistant:a2', 't2:assistant:c2', 't2:assistant:r2',
      't3:assistant:a3', 't4:assistant:before-u3',
    ]);
    expect(store.getFinalAnswer('t1:user:u2')?.id).toBe('t3:assistant:a3');
    expect(store.getThread('t4:user:u3').map((message) => message.id)).toEqual([
      't4:user:u3', 't4:assistant:after-u3', 't5:assistant:a5',
    ]);
    expect(store.getParts('t2:assistant:r2')).toEqual([expect.objectContaining({ text: 'continued' })]);
  });

  it('keeps leading userless content as assistant roots without inventing user content', () => {
    const history = normalizeCodexTurnsToHistory({
      sessionId: 's',
      turns: [
        { id: 't1', createdAt: 100, items: [command('c1')] },
        { id: 't2', createdAt: 200, items: [{ id: 'r2', type: 'reasoning', summary: ['leading'] }] },
        { id: 't3', createdAt: 300, items: [user('u3'), reply('a3')] },
        { id: 't4', createdAt: 400, items: [reply('a4')] },
      ],
    });
    const store = useMessages();
    store.loadHistory(history);
    expect(history.filter((entry) => entry.info.role === 'user').map((entry) => entry.info.id)).toEqual(['t3:user:u3']);
    expect(store.roots.value.map((root) => root.id)).toEqual(['t1:assistant:c1', 't2:assistant:r2', 't3:user:u3']);
    expect(store.getParts('t1:assistant:c1')[0]?.type).toBe('tool');
    expect(store.getParts('t2:assistant:r2')[0]?.type).toBe('reasoning');
    expect(store.getFinalAnswer('t3:user:u3')?.id).toBe('t4:assistant:a4');
  });
});
