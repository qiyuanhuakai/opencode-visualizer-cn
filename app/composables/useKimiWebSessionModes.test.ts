import { describe, expect, it, vi } from 'vitest';

import { KimiWebTowerExperimentUnavailableError } from '../backends/kimiWeb/kimiWebAdapter';
import type { KimiWebSessionModeChange } from '../backends/kimiWeb/sessionModes';
import { KimiWebError, KimiWebTransportError } from '../utils/kimiWeb';
import { useKimiWebSessionModes } from './useKimiWebSessionModes';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createController(
  writeMode: (sessionId: string, change: KimiWebSessionModeChange) => Promise<void> = vi
    .fn()
    .mockResolvedValue(undefined),
  loadMeta: () => Promise<unknown> = vi
    .fn()
    .mockResolvedValue({ experimental_flags: { tower: true } }),
) {
  return useKimiWebSessionModes({ writeMode, loadMeta });
}

describe('useKimiWebSessionModes', () => {
  it('retains an accepted local mode when GET omits mode fields', async () => {
    const controller = createController();

    await controller.changeMode('session-a', { field: 'planMode', value: true });
    controller.applyEvent('session-a', {}, { epoch: 'server-a', sequence: 1, origin: 'live' });

    expect(controller.sessionState('session-a')).toMatchObject({
      planMode: true,
      confidence: 'accepted-locally',
    });
  });

  it('classifies a real KimiWebError business rejection as rejected', async () => {
    const rejected = new KimiWebError(
      40001,
      'agent_config.permission_mode: Invalid option: expected one of "manual"|"yolo"|"auto"',
    );
    const writeMode = vi.fn(async (_sessionId: string, change: KimiWebSessionModeChange) => {
      if (change.field === 'planMode') throw rejected;
    });
    const controller = createController(writeMode);
    controller.applyEvent(
      'session-a',
      { planMode: false, swarmMode: true },
      { epoch: 'server-a', sequence: 1, origin: 'live' },
    );

    await expect(
      controller.changeMode('session-a', { field: 'planMode', value: true }),
    ).rejects.toBe(rejected);

    expect(controller.sessionState('session-a')).toMatchObject({
      planMode: false,
      swarmMode: true,
      error: { kind: 'rejected', message: rejected.message },
    });
  });

  it('classifies a tower-experiment rejection as rejected', async () => {
    const rejected = new KimiWebTowerExperimentUnavailableError('session-a');
    const controller = createController(vi.fn().mockRejectedValue(rejected));

    await expect(
      controller.changeMode('session-a', { field: 'towerMode', value: true }),
    ).rejects.toBe(rejected);

    expect(controller.sessionState('session-a')).toMatchObject({
      confidence: 'unknown',
      error: { kind: 'rejected', message: rejected.message },
    });
    expect(controller.sessionState('session-a')).not.toHaveProperty('towerMode');
  });

  it('keeps KimiWebTransportError classified as uncertain', async () => {
    const networkError = new KimiWebTransportError('boom', {
      kind: 'network',
      path: '/api/v1/x',
    });
    const writeMode = vi.fn().mockRejectedValue(networkError);
    const controller = createController(writeMode);

    await expect(
      controller.changeMode('session-a', { field: 'permissionMode', value: 'yolo' }),
    ).rejects.toBe(networkError);
    await Promise.resolve();

    expect(writeMode).toHaveBeenCalledTimes(1);
    expect(controller.sessionState('session-a')).toMatchObject({
      permissionMode: 'yolo',
      confidence: 'accepted-locally',
      error: { kind: 'uncertain' },
    });
  });

  it('keeps a generic Error classified as uncertain', async () => {
    const genericError = new Error('boom');
    const controller = createController(vi.fn().mockRejectedValue(genericError));

    await expect(
      controller.changeMode('session-a', { field: 'swarmMode', value: true }),
    ).rejects.toBe(genericError);

    expect(controller.sessionState('session-a')).toMatchObject({
      swarmMode: true,
      confidence: 'accepted-locally',
      error: { kind: 'uncertain' },
    });
  });

  it('keeps A responses out of B after a session switch', async () => {
    const writeA = deferred();
    const writeMode = vi.fn((sessionId: string) =>
      sessionId === 'session-a' ? writeA.promise : Promise.resolve(),
    );
    const controller = createController(writeMode);

    const pendingA = controller.changeMode('session-a', { field: 'planMode', value: true });
    await controller.changeMode('session-b', { field: 'swarmMode', value: true });
    writeA.resolve();
    await pendingA;

    expect(controller.sessionState('session-a')).toMatchObject({ planMode: true });
    expect(controller.sessionState('session-b')).toEqual({
      swarmMode: true,
      confidence: 'accepted-locally',
    });
  });

  it('preserves false and ignores omitted event fields', () => {
    const controller = createController();
    controller.applyEvent(
      'session-a',
      { planMode: true, swarmMode: true },
      { epoch: 'server-a', sequence: 1, origin: 'live' },
    );
    controller.applyEvent(
      'session-a',
      { swarmMode: false },
      { epoch: 'server-a', sequence: 2, origin: 'live' },
    );

    expect(controller.sessionState('session-a')).toMatchObject({
      planMode: true,
      swarmMode: false,
      confidence: 'confirmed',
    });
  });

  it('ignores stale replay and reconciles a newer authoritative event', () => {
    const controller = createController();
    controller.applyEvent(
      'session-a',
      { permission: 'manual' },
      { epoch: 'server-a', sequence: 8, origin: 'durable-replay' },
    );
    controller.applyEvent(
      'session-a',
      { permission: 'yolo' },
      { epoch: 'server-a', sequence: 10, origin: 'live' },
    );
    controller.applyEvent(
      'session-a',
      { permission: 'auto' },
      { epoch: 'server-a', sequence: 9, origin: 'durable-replay' },
    );

    expect(controller.sessionState('session-a')).toMatchObject({
      permissionMode: 'yolo',
      confidence: 'confirmed',
    });
  });

  it('does not let HTTP completion overwrite a newer event', async () => {
    const write = deferred();
    const controller = createController(() => write.promise);
    const pending = controller.changeMode('session-a', { field: 'planMode', value: true });
    controller.applyEvent(
      'session-a',
      { planMode: false },
      { epoch: 'server-a', sequence: 4, origin: 'live' },
    );

    write.resolve();
    await pending;

    expect(controller.sessionState('session-a')).toMatchObject({
      planMode: false,
      confidence: 'confirmed',
    });
  });

  it('marks cached values stale on reconnect without reapplying them', async () => {
    const writeMode = vi.fn().mockResolvedValue(undefined);
    const controller = createController(writeMode);
    await controller.changeMode('session-a', { field: 'permissionMode', value: 'yolo' });
    await controller.changeMode('session-a', { field: 'towerMode', value: true });
    writeMode.mockClear();

    controller.markStale('session-a');
    await Promise.resolve();

    expect(controller.sessionState('session-a')).toMatchObject({
      permissionMode: 'yolo',
      towerMode: true,
      confidence: 'stale',
    });
    expect(writeMode).not.toHaveBeenCalled();
  });

  it('invalidates confirmation when server identity changes', () => {
    const controller = createController();
    controller.applyEvent(
      'session-a',
      { planMode: true },
      { epoch: 'server-a', sequence: 3, origin: 'live' },
    );
    controller.applyEvent(
      'session-a',
      {},
      { epoch: 'server-b', sequence: 1, origin: 'snapshot-rebuild' },
    );

    expect(controller.sessionState('session-a')).toMatchObject({
      planMode: true,
      confidence: 'stale',
    });
  });

  it('never writes modes to browser storage', async () => {
    const localSetItem = vi.fn();
    const sessionSetItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem: localSetItem });
    vi.stubGlobal('sessionStorage', { setItem: sessionSetItem });
    const controller = createController();

    await controller.changeMode('session-a', { field: 'planMode', value: true });
    controller.markStale('session-a');
    controller.resetSession('session-a');
    controller.dispose();

    expect(localSetItem).not.toHaveBeenCalled();
    expect(sessionSetItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('gates tower enable on the experimental flag', async () => {
    const disabledWrite = vi.fn().mockResolvedValue(undefined);
    const disabled = createController(disabledWrite, async () => ({
      experimental_flags: { tower: false },
    }));

    await expect(
      disabled.changeMode('session-a', { field: 'towerMode', value: true }),
    ).rejects.toThrow('Tower mode is not enabled');
    expect(disabledWrite).not.toHaveBeenCalled();
    expect(disabled.towerEnabled).toBe(false);

    const enabledWrite = vi.fn().mockResolvedValue(undefined);
    const enabled = createController(enabledWrite, async () => ({
      experimental_flags: { tower: true },
    }));
    await enabled.changeMode('session-a', { field: 'towerMode', value: true });

    expect(enabledWrite).toHaveBeenCalledTimes(1);
    expect(enabled.towerEnabled).toBe(true);
  });

  it('refuses a second in-flight mutation for the same session', async () => {
    const firstWrite = deferred();
    const writeMode = vi.fn(() => firstWrite.promise);
    const controller = createController(writeMode);
    const first = controller.changeMode('session-a', { field: 'planMode', value: true });

    await expect(
      controller.changeMode('session-a', { field: 'swarmMode', value: true }),
    ).rejects.toThrow('Session mode change already in flight');
    expect(writeMode).toHaveBeenCalledTimes(1);
    expect(controller.sessionState('session-a')).not.toHaveProperty('swarmMode');

    firstWrite.resolve();
    await first;
  });
});
