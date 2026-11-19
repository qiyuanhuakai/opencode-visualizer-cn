// @vitest-environment node
import { setImmediate } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { createAcpRpc } from '../../../bridge/runtime/drivers/acpRpc.js';

function fixture(close: () => Promise<void>, onExit = () => {}) {
  return createAcpRpc({
    manager: {
      async reconcile() {
        return [];
      },
      getStatus() {
        return [];
      },
      async stopAll() {},
      attach() {
        return { processGeneration: 1, pid: 42, setRawTap() {}, close };
      },
    },
    agentId: 'owned',
    async onRequest() {},
    onNotification() {},
    onExit,
  });
}

test('reentrant close waits for the same native attachment cleanup', async () => {
  const gate = Promise.withResolvers<void>();
  let reentrant: Promise<void> | undefined;
  let finished = false;
  const rpc = fixture(
    () => gate.promise,
    () => {
      reentrant = rpc.close().then(() => {
        finished = true;
      });
    },
  );
  const first = rpc.close();
  try {
    await setImmediate();
    expect(rpc.active).toBe(false);
    expect(finished).toBe(false);
    expect(() => rpc.notify('session/cancel', {})).toThrow();
  } finally {
    gate.resolve();
    await Promise.all([first, reentrant]);
  }
});

test('a failed native attachment cleanup can be retried without reopening admission', async () => {
  let attempts = 0;
  const rpc = fixture(async () => {
    if (++attempts === 1) throw new Error('controlled cleanup failure');
  });
  await expect(rpc.close()).rejects.toThrow('controlled cleanup failure');
  expect(rpc.active).toBe(false);
  await expect(rpc.close()).resolves.toBeUndefined();
  expect(attempts).toBe(2);
  expect(() => rpc.notify('session/cancel', {})).toThrow();
});
