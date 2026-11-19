// @vitest-environment node
import { expect, it } from 'vitest';
import { createAdmissionQueue } from '../bridge/runtime/admissionQueue.js';

const blockEventLoop = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); };

it('never reports success when synchronous work finishes after the actual deadline', async () => {
  const queue = createAdmissionQueue();
  await expect(queue.run({ deadlineMs: 5 }, () => { blockEventLoop(); return 'too late'; })).rejects.toMatchObject({ code: 'timeout', reason: 'deadline' });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(queue.pending.total).toBe(0);
});

it('does not start queued native work after its deadline even if the timer callback has not run', async () => {
  const queue = createAdmissionQueue();
  let native = 0;
  const result = queue.run({ deadlineMs: 5 }, () => { native++; });
  blockEventLoop();
  await expect(result).rejects.toMatchObject({ code: 'timeout', reason: 'deadline' });
  expect(native).toBe(0);
});

it('refuses a late payload reservation before native submission', async () => {
  const queue = createAdmissionQueue();
  let native = 0;
  await expect(queue.run({ deadlineMs: 5, size: 17 }, (_signal, reserve) => {
    blockEventLoop(); reserve(100); native++;
  })).rejects.toMatchObject({ code: 'timeout', reason: 'deadline' });
  expect(native).toBe(0);
});
