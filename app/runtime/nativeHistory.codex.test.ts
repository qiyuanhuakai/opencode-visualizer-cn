import { expect, it } from 'vitest';
import { createNativeHistoryProjection } from './nativeHistory';
import type { MessageInfo, MessagePart } from '../types/sse';

type Entry = { info: MessageInfo; parts: MessagePart[] };
const user = (id: string, text: string) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
const assistant = (id: string, text: string) => ({ id, type: 'agentMessage', text });

it('renders newest-first Codex pages chronologically and repairs parents when older prompts arrive', () => {
  const project = createNativeHistoryProjection('codex', 'selected');
  const newest = project({ turnId: 't2', item: assistant('a2', 'latest answer'), startedAtMs: 2000 }) as Entry[];
  expect(newest[0]!.info).toMatchObject({ role: 'assistant', parentID: '' });
  let entries = project({ turnId: 't2', item: user('u2', 'latest question'), startedAtMs: 1000 }) as Entry[];
  expect(entries.map(entry => entry.info.role)).toEqual(['user', 'assistant']);
  expect(entries[1]!.info).toMatchObject({ parentID: entries[0]!.info.id });
  project({ turnId: 't1', item: assistant('a1', 'older answer'), startedAtMs: 500 });
  entries = project({ turnId: 't1', item: user('u1', 'older question'), startedAtMs: 100 }) as Entry[];
  expect(entries.flatMap(entry => entry.parts.filter(part => part.type === 'text').map(part => part.text))).toEqual(['older question', 'older answer', 'latest question', 'latest answer']);
  expect(entries[1]!.info).toMatchObject({ parentID: entries[0]!.info.id });
  expect(entries[3]!.info).toMatchObject({ parentID: entries[2]!.info.id });
  expect(entries.every(entry => entry.info.sessionID === 'selected')).toBe(true);
});

it('links a continuation turn to the older prompt rather than a newer turn and bounds its retained window', () => {
  const project = createNativeHistoryProjection('codex', 'selected');
  project({ turnId: 'continuation', item: assistant('continued', 'continued answer') });
  const entries = project({ turnId: 'initial', item: user('root', 'original prompt') }) as Entry[];
  expect(entries[1]!.info).toMatchObject({ parentID: entries[0]!.info.id });
  let window: unknown[] = [];
  for (let index = 0; index < 205; index++) window = project({ turnId: `older-${index}`, item: user(`u-${index}`, `older ${index}`) });
  expect(window).toHaveLength(200);
  expect(JSON.stringify(window)).not.toContain('continued answer');
  expect((window[0] as Entry).parts[0]).toMatchObject({ text: 'older 204' });
});
