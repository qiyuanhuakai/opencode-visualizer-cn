import { describe, expect, it } from 'vitest';

import { createPendingPtyCreateRegistry, isCurrentPtySocket } from './ptyLifecycle';

describe('createPendingPtyCreateRegistry', () => {
  it('shares one in-flight PTY window creation for the same id', async () => {
    let resolveCreation!: (value: string) => void;
    const creation = new Promise<string>((resolve) => {
      resolveCreation = resolve;
    });
    const registry = createPendingPtyCreateRegistry<string>();
    let calls = 0;

    const first = registry.getOrCreate('pty-1', () => {
      calls += 1;
      return creation;
    });
    const second = registry.getOrCreate('pty-1', () => {
      calls += 1;
      return Promise.resolve('duplicate');
    });

    expect(second).toBe(first);
    expect(calls).toBe(1);
    resolveCreation('created');
    await expect(first).resolves.toBe('created');
    expect(registry.get('pty-1')).toBeUndefined();
  });

  it('invalidates an in-flight creation before its deferred factory resolves', async () => {
    let resolveCreation!: (value: string) => void;
    const creation = new Promise<string>((resolve) => {
      resolveCreation = resolve;
    });
    const registry = createPendingPtyCreateRegistry<string>();
    let currentAtResolve = true;

    const first = registry.getOrCreate('pty-1', async (isCurrent) => {
      const value = await creation;
      currentAtResolve = isCurrent();
      return value;
    });
    registry.invalidate('pty-1');
    resolveCreation('created');

    await expect(first).resolves.toBe('created');
    expect(currentAtResolve).toBe(false);
    expect(registry.get('pty-1')).toBeUndefined();
  });

  it('invalidates every pending creation for renderer teardown', async () => {
    let resolveCreation!: (value: string) => void;
    const creation = new Promise<string>((resolve) => {
      resolveCreation = resolve;
    });
    const registry = createPendingPtyCreateRegistry<string>();
    let currentAtResolve = true;

    const first = registry.getOrCreate('pty-1', (isCurrent) =>
      creation.then((value) => {
        currentAtResolve = isCurrent();
        return value;
      }),
    );
    registry.invalidateAll();
    resolveCreation('created');

    await expect(first).resolves.toBe('created');
    expect(currentAtResolve).toBe(false);
  });

  it('does not let an invalidated create affect a newer create for the same id', async () => {
    let resolveOld!: (value: string) => void;
    let resolveNew!: (value: string) => void;
    const oldCreation = new Promise<string>((resolve) => {
      resolveOld = resolve;
    });
    const newCreation = new Promise<string>((resolve) => {
      resolveNew = resolve;
    });
    const registry = createPendingPtyCreateRegistry<string>();
    let oldCurrentAtResolve = true;

    const oldPending = registry.getOrCreate('pty-1', async (isCurrent) => {
      const value = await oldCreation;
      oldCurrentAtResolve = isCurrent();
      return value;
    });
    registry.invalidate('pty-1');
    const newPending = registry.getOrCreate('pty-1', () => newCreation);

    resolveOld('old');
    await expect(oldPending).resolves.toBe('old');
    expect(oldCurrentAtResolve).toBe(false);
    expect(registry.get('pty-1')).toBe(newPending);

    resolveNew('new');
    await expect(newPending).resolves.toBe('new');
  });
});

describe('isCurrentPtySocket', () => {
  it('rejects callbacks from a socket replaced for the same PTY', () => {
    const oldSocket = {};
    const newSocket = {};
    const session = { socket: oldSocket };
    const sessions = new Map([['pty-1', session]]);
    session.socket = newSocket;

    expect(isCurrentPtySocket(sessions, 'pty-1', session, oldSocket)).toBe(false);
    expect(isCurrentPtySocket(sessions, 'pty-1', session, newSocket)).toBe(true);
  });

  it('rejects callbacks from a removed session after its PTY id is reused', () => {
    const oldSession = { socket: {} };
    const currentSession = { socket: {} };
    const sessions = new Map([['pty-1', currentSession]]);

    expect(isCurrentPtySocket(sessions, 'pty-1', oldSession, oldSession.socket)).toBe(false);
  });
});
