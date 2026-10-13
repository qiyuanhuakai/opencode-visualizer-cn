import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createConnectionManager } from '../../bridge/runtime/transports/connectionManager.js';
import type { OpenTransport } from '../../bridge/runtime/transports/connectionManager.js';
import { createProfileStore } from '../../bridge/runtime/transports/profileStore.js';
import { resolveProfileEnvironment } from '../../shared/runtime/connectionProfile.js';
import { parseEnvironmentId } from '../../shared/runtime/identity.js';

const environment = parseEnvironmentId('11111111-1111-4111-8111-111111111111');

function localProfileInput() {
  return {
    name: 'Workstation',
    transport: { kind: 'local' as const },
    target: { kind: 'local' as const, environmentId: environment },
    role: 'local' as const,
    credentialRef: 'cred-1',
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Flush every pending microtask, so a concurrently started connect has reached its decision. */
function settleMicrotasks() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * A transport whose dial stays in flight until `release()` is called. It records every handle and
 * every `close()` so the assertions can count live handles instead of trusting a state string.
 */
function dialHarness() {
  const started = deferred<void>();
  const gate = deferred<void>();
  const closes: Array<ReturnType<typeof vi.fn>> = [];
  let opened = 0;
  const openTransport: OpenTransport = async (profile) => {
    opened += 1;
    started.resolve();
    await gate.promise;
    const close = vi.fn();
    closes.push(close);
    return { environmentId: resolveProfileEnvironment(profile), connectionId: `h-${opened}`, close };
  };
  return {
    openTransport,
    started: started.promise,
    release: () => gate.resolve(),
    opened: () => opened,
    closeCalls: () => closes.reduce((total, close) => total + close.mock.calls.length, 0),
    live: () => closes.filter((close) => close.mock.calls.length === 0).length,
  };
}

async function setupManager(openTransport: OpenTransport) {
  const directory = await mkdtemp(path.join(tmpdir(), 'vis-conn-dial-'));
  const store = createProfileStore({ profilePath: path.join(directory, 'profiles.json') });
  const manager = createConnectionManager({ store, openTransport });
  const created = await manager.create(localProfileInput());
  await manager.setEnabled(created.profileId, true);
  return { directory, manager, profileId: created.profileId };
}

describe('connection manager dial retirement (review round 18d8ae82b item 3)', () => {
  it('retires and closes an in-flight dial when the profile is deleted', async () => {
    const dial = dialHarness();
    const { directory, manager, profileId } = await setupManager(dial.openTransport);
    try {
      const connecting = manager.connect(profileId);
      await dial.started;
      const receipt = await manager.delete(profileId);

      const rejected = expect(connecting).rejects.toMatchObject({ code: 'source_unavailable' });
      dial.release();
      await rejected;

      expect(receipt.removed).toBe(profileId);
      expect(dial.opened()).toBe(1);
      expect(dial.closeCalls()).toBe(1);
      expect(dial.live()).toBe(0);
      expect(await manager.list()).toEqual([]);
      expect(await manager.status(profileId)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retires and closes an in-flight dial when the connection is disconnected', async () => {
    const dial = dialHarness();
    const { directory, manager, profileId } = await setupManager(dial.openTransport);
    try {
      const connecting = manager.connect(profileId);
      await dial.started;
      const status = await manager.disconnect(profileId);
      expect(status.state).toBe('disconnected');

      const rejected = expect(connecting).rejects.toMatchObject({ code: 'conflict' });
      dial.release();
      await rejected;

      expect(dial.opened()).toBe(1);
      expect(dial.closeCalls()).toBe(1);
      expect(dial.live()).toBe(0);
      expect((await manager.status(profileId))?.state).toBe('disconnected');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('deduplicates concurrent connects so only one handle ever exists', async () => {
    const dial = dialHarness();
    const { directory, manager, profileId } = await setupManager(dial.openTransport);
    try {
      const first = manager.connect(profileId);
      await dial.started;
      const second = manager.connect(profileId);
      await settleMicrotasks();
      dial.release();
      const [a, b] = await Promise.all([first, second]);

      expect(a.state).toBe('connected');
      expect(b.state).toBe('connected');
      expect(a.environmentId).toBe(environment);
      expect(dial.opened()).toBe(1);
      expect(dial.live()).toBe(1);
      expect(dial.closeCalls()).toBe(0);

      await manager.disconnect(profileId);
      expect(dial.closeCalls()).toBe(1);
      expect(dial.live()).toBe(0);
      expect((await manager.status(profileId))?.state).toBe('disconnected');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
