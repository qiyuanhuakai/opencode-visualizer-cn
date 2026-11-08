// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { createRuntimeStore } from '../bridge/runtime/storage/runtimeStore.js';

const observed = vi.hoisted(() => ({ worker: null as ChildProcess | null }));
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, fork: (...args: Parameters<typeof original.fork>) => {
    const worker = original.fork(...args); observed.worker = worker; return worker;
  } };
});

it('waits for physical worker exit after an IPC error instead of acknowledging exit from the error event', async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'vis-store-exit-barrier-'));
  const store = createRuntimeStore({ stateDirectory, environmentId: '11111111-1111-4111-8111-111111111111', ownerId: '22222222-2222-4222-8222-222222222222', epoch: '33333333-3333-4333-8333-333333333333' });
  let physicalExit: Promise<void> | undefined;
  try {
    await store.ready;
    const worker = observed.worker!;
    expect(Boolean(worker?.pid)).toBe(true);
    let exited = false;
    physicalExit = new Promise(resolve => worker.once('exit', () => { exited = true; resolve(); }));
    // Real worker + controlled IPC fault: the production owner still sends the
    // actual SIGKILL. No fake process or intercepted kill is used.
    worker.emit('error', new Error('injected IPC transport error'));
    await store.close();
    expect(exited).toBe(true);
  } finally {
    await store.terminate();
    await physicalExit;
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
