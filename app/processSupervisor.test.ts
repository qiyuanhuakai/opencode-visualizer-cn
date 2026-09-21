import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { KIMI_TOKEN_UNREADABLE, KimiWebTokenError } from '../bridge/kimiWebToken.js';
import {
  createNativeServiceDefinitions,
  createProcessSupervisor,
} from '../bridge/processSupervisor.js';

const FAKE_KIMI_DIR = '/tmp/opencode';
const FAKE_KIMI_SCRIPT = `${FAKE_KIMI_DIR}/process-supervisor-fake-kimi.mjs`;
const spawnedChildren: ChildProcess[] = [];

beforeAll(() => {
  mkdirSync(FAKE_KIMI_DIR, { recursive: true });
  writeFileSync(
    FAKE_KIMI_SCRIPT,
    [
      'const url = process.env.FAKE_KIMI_URL;',
      "const delay = Number(process.env.FAKE_KIMI_DELAY_MS ?? '0');",
      'if (url) setTimeout(() => console.log(url), delay);',
      'setInterval(() => {}, 1_000);',
    ].join('\n'),
  );
});

afterEach(() => {
  for (const child of spawnedChildren.splice(0)) {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  }
});

function fakeKimiSpawn(url?: string, delayMs = 0) {
  return vi.fn((_command: string, _args: readonly string[], options: SpawnOptions) => {
    const child = spawn(process.execPath, [FAKE_KIMI_SCRIPT], {
      ...options,
      env: {
        ...process.env,
        FAKE_KIMI_URL: url,
        FAKE_KIMI_DELAY_MS: String(delayMs),
      },
    });
    spawnedChildren.push(child);
    return child;
  });
}

function expectChildStopped(child: ChildProcess | undefined) {
  expect(child?.pid).toBeTypeOf('number');
  expect(() => process.kill(child?.pid ?? 0, 0)).toThrow();
}

function kimiService() {
  const service = createNativeServiceDefinitions().find(({ id }) => id === 'kimi-web');
  if (!service) throw new Error('Missing kimi-web service definition.');
  return service;
}

function kimiDependencies() {
  return {
    kimiWebTokenProvider: { getAuthorization: vi.fn(() => 'Bearer test-token') },
    probeKimiWebAuth: vi.fn().mockResolvedValue({ ok: true }),
  };
}

describe('processSupervisor', () => {
  it('uses verified OpenCode, Codex, and Kimi Web native launch commands', () => {
    expect(createNativeServiceDefinitions()).toEqual([
      expect.objectContaining({
        id: 'opencode',
        command: 'opencode',
        args: ['serve', '--hostname', '127.0.0.1', '--port', '4096'],
      }),
      expect.objectContaining({
        id: 'codex',
        command: 'codex',
        args: ['app-server', '--listen', 'ws://127.0.0.1:4500'],
      }),
      {
        id: 'kimi-web',
        name: 'Kimi Web',
        command: 'kimi',
        args: ['web', '--port', '58627', '--no-open'],
        probe: {
          type: 'http',
          url: 'http://127.0.0.1:58627/api/v1/healthz',
          expectJson: { 'data.ok': true },
        },
      },
    ]);
  });

  it('adopts healthy native services without spawning or owning them', async () => {
    const spawnProcess = vi.fn();
    const supervisor = createProcessSupervisor({
      services: [createNativeServiceDefinitions()[0]],
      spawnProcess,
      probeService: vi.fn().mockResolvedValue(true),
    });

    await supervisor.start();

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(supervisor.getStatus()).toEqual([
      expect.objectContaining({ id: 'opencode', state: 'adopted', owned: false }),
    ]);
    await supervisor.stop();
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('adopts kimi web only when health shape and direct auth both pass', async () => {
    const spawnProcess = vi.fn();
    const probeKimiWebAuth = vi.fn().mockResolvedValue({ ok: true });
    const supervisor = createProcessSupervisor({
      services: [kimiService()],
      spawnProcess,
      probeKimiWebHealth: vi.fn().mockResolvedValue({ state: 'matching' }),
      probeKimiWebAuth,
      kimiWebTokenProvider: { getAuthorization: vi.fn(() => 'Bearer current-token') },
    });

    await supervisor.start();

    expect(probeKimiWebAuth).toHaveBeenCalledWith('Bearer current-token');
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(supervisor.getStatus()).toEqual([
      expect.objectContaining({ id: 'kimi-web', state: 'adopted', owned: false }),
    ]);
  });

  it('reports an occupied non-kimi port without spawning', async () => {
    const spawnProcess = vi.fn();
    const probeKimiWebAuth = vi.fn();
    const supervisor = createProcessSupervisor({
      services: [kimiService()],
      spawnProcess,
      probeKimiWebHealth: vi.fn().mockResolvedValue({
        state: 'mismatch',
        reason: 'health response did not match data.ok=true',
      }),
      ...kimiDependencies(),
      probeKimiWebAuth,
    });

    await supervisor.start();

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(probeKimiWebAuth).not.toHaveBeenCalled();
    expect(supervisor.getStatus()[0]).toEqual(
      expect.objectContaining({
        state: 'error',
        owned: false,
        error: expect.stringContaining('data.ok'),
      }),
    );
  });

  it.each([
    {
      name: 'the token is unreadable',
      tokenProvider: {
        getAuthorization: () => {
          throw new KimiWebTokenError(KIMI_TOKEN_UNREADABLE, 'token file unreadable');
        },
      },
      probeAuth: vi.fn(),
      error: 'Run `kimi web` once manually',
    },
    {
      name: 'meta rejects the token',
      tokenProvider: { getAuthorization: () => 'Bearer rejected-token' },
      probeAuth: vi.fn().mockResolvedValue({ ok: false, reason: 'meta returned HTTP 401' }),
      error: '401',
    },
  ])(
    'reports credential failure without spawning when $name',
    async ({ tokenProvider, probeAuth, error }) => {
      const spawnProcess = vi.fn();
      const supervisor = createProcessSupervisor({
        services: [kimiService()],
        spawnProcess,
        probeKimiWebHealth: vi.fn().mockResolvedValue({ state: 'matching' }),
        probeKimiWebAuth: probeAuth,
        kimiWebTokenProvider: tokenProvider,
      });

      await supervisor.start();

      expect(spawnProcess).not.toHaveBeenCalled();
      expect(supervisor.getStatus()[0]).toEqual(
        expect.objectContaining({
          state: 'error',
          owned: false,
          error: expect.stringContaining(error),
        }),
      );
    },
  );

  it('spawns idle kimi web and waits for child-owned port 58627 before running', async () => {
    const spawnProcess = fakeKimiSpawn('http://127.0.0.1:58627/#token=secret');
    const probeKimiWebHealth = vi
      .fn()
      .mockResolvedValueOnce({ state: 'idle' })
      .mockResolvedValue({ state: 'matching' });
    const supervisor = createProcessSupervisor({
      services: [kimiService()],
      spawnProcess,
      probeKimiWebHealth,
      ...kimiDependencies(),
      readinessAttempts: 10,
      readinessIntervalMs: 5,
    });

    await supervisor.start();

    expect(supervisor.getStatus()[0]).toEqual(
      expect.objectContaining({ id: 'kimi-web', state: 'running', owned: true }),
    );
    await supervisor.stop();
    expectChildStopped(spawnedChildren[0]);
  });

  it('stops kimi web when its startup line reports a drifted port', async () => {
    const spawnProcess = fakeKimiSpawn('http://127.0.0.1:58628/#token=secret');
    const supervisor = createProcessSupervisor({
      services: [kimiService()],
      spawnProcess,
      probeKimiWebHealth: vi.fn().mockResolvedValue({ state: 'idle' }),
      ...kimiDependencies(),
      readinessAttempts: 10,
      readinessIntervalMs: 5,
    });

    await supervisor.start();

    expect(supervisor.getStatus()[0]).toEqual(
      expect.objectContaining({
        state: 'error',
        owned: false,
        error: expect.stringContaining('58628'),
      }),
    );
    expectChildStopped(spawnedChildren[0]);
  });

  it('stops a kimi child that never prints ownership evidence before readiness timeout', async () => {
    const spawnProcess = fakeKimiSpawn();
    const supervisor = createProcessSupervisor({
      services: [kimiService()],
      spawnProcess,
      probeKimiWebHealth: vi.fn().mockResolvedValue({ state: 'idle' }),
      ...kimiDependencies(),
      readinessAttempts: 2,
      readinessIntervalMs: 0,
    });

    await supervisor.start();

    expect(supervisor.getStatus()[0]).toEqual(
      expect.objectContaining({
        state: 'error',
        owned: false,
        error: expect.stringContaining('did not become ready'),
      }),
    );
    expectChildStopped(spawnedChildren[0]);
  });

  it('rejects a racing usable kimi instance when the spawned child owns port 58628', async () => {
    const spawnProcess = fakeKimiSpawn('http://127.0.0.1:58628/#token=secret', 15);
    const probeKimiWebHealth = vi
      .fn()
      .mockResolvedValueOnce({ state: 'idle' })
      .mockResolvedValue({ state: 'matching' });
    const supervisor = createProcessSupervisor({
      services: [kimiService()],
      spawnProcess,
      probeKimiWebHealth,
      ...kimiDependencies(),
      readinessAttempts: 20,
      readinessIntervalMs: 5,
    });

    await supervisor.start();

    expect(probeKimiWebHealth.mock.calls.length).toBeGreaterThan(1);
    expect(supervisor.getStatus()[0]).toEqual(
      expect.objectContaining({
        state: 'error',
        owned: false,
        error: expect.stringContaining('race'),
      }),
    );
    expectChildStopped(spawnedChildren[0]);
  });

  it('spawns unavailable services and terminates only owned children', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    spawnedChildren.push(child);
    const kill = vi.spyOn(child, 'kill');
    const supervisor = createProcessSupervisor({
      services: [createNativeServiceDefinitions()[1]],
      spawnProcess: vi.fn(() => child),
      probeService: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      readinessIntervalMs: 0,
    });

    await supervisor.start();
    expect(supervisor.getStatus()).toEqual([
      expect.objectContaining({ id: 'codex', state: 'running', owned: true, pid: child.pid }),
    ]);

    await supervisor.stop();

    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(supervisor.getStatus()).toEqual([
      expect.objectContaining({ id: 'codex', state: 'stopped', owned: false }),
    ]);
  });

  it('reports spawn errors without taking down other bridge surfaces', async () => {
    const supervisor = createProcessSupervisor({
      services: [createNativeServiceDefinitions()[0]],
      spawnProcess: vi.fn(() => {
        const child = spawn('vis-definitely-missing-opencode', [], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        spawnedChildren.push(child);
        return child;
      }),
      probeService: vi.fn().mockResolvedValue(false),
      readinessAttempts: 1,
      readinessIntervalMs: 0,
    });

    await supervisor.start();

    expect(supervisor.getStatus()).toEqual([
      expect.objectContaining({
        id: 'opencode',
        state: 'error',
        owned: false,
        error: expect.stringContaining('ENOENT'),
      }),
    ]);
  });

  it('reclaims each failed readiness generation before allowing a retry', async () => {
    const spawnProcess = vi.fn(() => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      spawnedChildren.push(child);
      return child;
    });
    const supervisor = createProcessSupervisor({
      services: [createNativeServiceDefinitions()[0]],
      spawnProcess,
      probeService: vi.fn().mockResolvedValue(false),
      readinessAttempts: 1,
      readinessIntervalMs: 0,
    });

    await supervisor.start();
    const firstPid = spawnedChildren[0]?.pid;
    expect(() => process.kill(firstPid ?? 0, 0)).toThrow();
    await supervisor.start();
    const secondPid = spawnedChildren[1]?.pid;

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(() => process.kill(firstPid ?? 0, 0)).toThrow();
    expect(() => process.kill(secondPid ?? 0, 0)).toThrow();
    await supervisor.stop();
  });
});
