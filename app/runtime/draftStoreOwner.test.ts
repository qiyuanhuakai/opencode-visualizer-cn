// @vitest-environment node
import { expect, it } from 'vitest';
import { createDraftStoreOwner } from './draftStoreOwner';

it('shares an opening and waits for late allocation and admitted work before closing', async () => {
  let opens = 0, closes = 0;
  const opening = Promise.withResolvers<{ close(): void }>();
  const work = Promise.withResolvers<void>();
  const owner = createDraftStoreOwner(() => { opens++; return opening.promise; });
  const first = owner.get(), second = owner.get();
  await Promise.resolve();
  expect(opens).toBe(1);
  const rejected = Promise.all([expect(first).rejects.toThrow('closed'), expect(second).rejects.toThrow('closed')]);
  let done = false;
  const closing = owner.close(work.promise).then(() => { done = true; });
  opening.resolve({ close() { closes++; } });
  await rejected;
  expect(done).toBe(false); expect(closes).toBe(0);
  work.resolve(); await closing;
  expect(closes).toBe(1);
  await expect(owner.get()).rejects.toThrow('closed');
  await owner.close(); expect(closes).toBe(1);
});

it('retries a failed open without creating a second successful connection', async () => {
  let opens = 0, closes = 0;
  const store = { close() { closes++; } };
  const owner = createDraftStoreOwner(async () => { if (++opens === 1) throw new Error('open failed'); return store; });
  await expect(owner.get()).rejects.toThrow('open failed');
  expect(await owner.get()).toBe(store); expect(await owner.get()).toBe(store);
  expect(opens).toBe(2);
  await owner.close(); expect(closes).toBe(1);
});

it('retains a failed close for retry while refusing new acquisitions', async () => {
  let closes = 0;
  const owner = createDraftStoreOwner(async () => ({ close() { if (++closes === 1) throw new Error('close failed'); } }));
  await owner.get();
  await expect(owner.close()).rejects.toThrow('close failed');
  await expect(owner.get()).rejects.toThrow('closed');
  await owner.close(); expect(closes).toBe(2);
});
