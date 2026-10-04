import { expect, it, vi } from 'vitest';
import { resolveDshForkBoundary } from './forkBoundary';

it('forks before inbox acceptance rather than the later durable prompt twin', async () => {
  const fetchPage = vi.fn(async () => ({ records: [
    { type: 'event', event: { type: 'agent/inbox/spliced', seq: 24, time: 1,
      data: { inserted: [{ id: 'prompt-id', source: { kind: 'user' } }] } } },
    { type: 'event', event: { type: 'user/message', seq: 28, time: 2, data: { id: 'prompt-id' } } },
  ] }));
  await expect(resolveDshForkBoundary({ sessionId: 'source', messageId: 'prompt-id', cursor: 35, fetchPage }))
    .resolves.toBe(23);
  expect(fetchPage).toHaveBeenCalledWith({ address: { kind: 'session', sessionId: 'source' }, throughSeq: 35, beforeSeq: 36 });
});

it('walks older windows despite hasMore false and refuses a missing prompt', async () => {
  const fetchPage = vi.fn().mockResolvedValueOnce({ records: [
    { type: 'event', event: { type: 'user/message', seq: 28, time: 2, data: { id: 'other' } } },
  ], hasMore: false }).mockResolvedValueOnce({ records: [
    { type: 'event', event: { type: 'user/message', seq: 7, time: 1, data: { id: 'prompt-id' } } },
  ], hasMore: false }).mockResolvedValue({ records: [] });
  await expect(resolveDshForkBoundary({ sessionId: 'source', messageId: 'prompt-id', cursor: 35, fetchPage })).resolves.toBe(6);
  await expect(resolveDshForkBoundary({ sessionId: 'source', messageId: 'missing', cursor: 35, fetchPage })).rejects.toThrow();
});

it('finds an earlier inbox when the durable twin is in a newer page', async () => {
  const fetchPage = vi.fn().mockResolvedValueOnce({ records: [
    { type: 'event', event: { type: 'user/message', seq: 28, time: 2, data: { id: 'prompt-id' } } },
  ] }).mockResolvedValueOnce({ records: [
    { type: 'event', event: { type: 'agent/inbox/spliced', seq: 24, time: 1,
      data: { inserted: [{ id: 'prompt-id' }] } } },
  ] });
  await expect(resolveDshForkBoundary({ sessionId: 'source', messageId: 'prompt-id', cursor: 35, fetchPage })).resolves.toBe(23);
  expect(fetchPage).toHaveBeenCalledTimes(2);
});
