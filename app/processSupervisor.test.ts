import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { KIMI_TOKEN_UNREADABLE, KimiWebTokenError } from '../bridge/kimiWebToken.js';
import { computeDshAuthCookieName } from '../bridge/dshAuth.js';
import type {
  DshWebAuthProbeResult,
  DshWebFenceState,
  NativeServiceDefinition,
} from '../bridge/processSupervisor.js';
import {
  createNativeServiceDefinitions,
  createProcessSupervisor,
} from '../bridge/processSupervisor.js';

const FAKE_KIMI_DIR = '/tmp/opencode';
const FAKE_KIMI_SCRIPT = `${FAKE_KIMI_DIR}/process-supervisor-fake-kimi.mjs`;
const FAKE_DSH_SCRIPT = `${FAKE_KIMI_DIR}/process-supervisor-fake-dsh.mjs`;
const DSH_AUTHORITY = '127.0.0.1:3080';
const DSH_LAUNCH_LINE = `dsh web: http://${DSH_AUTHORITY}/?token=fake-launch-token`;
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
  writeFileSync(
    FAKE_DSH_SCRIPT,
    [
      'const url = process.env.FAKE_DSH_URL;',
      "const delay = Number(process.env.FAKE_DSH_DELAY_MS ?? '0');",
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

function fakeDshSpawn(launchLine?: string, delayMs = 0) {
  return vi.fn((_command: string, _args: readonly string[], options: SpawnOptions) => {
    const child = spawn(process.execPath, [FAKE_DSH_SCRIPT], {
      ...options,
      env: {
        ...process.env,
        FAKE_DSH_URL: launchLine,
        FAKE_DSH_DELAY_MS: String(delayMs),
      },
    });
    spawnedChildren.push(child);
    return child;
  });
}

function fakeDshExchange(cookieValue = 'probe-cookie-value') {
  return vi.fn().mockResolvedValue({
    status: 303,
    setCookie: [
      `${computeDshAuthCookieName(DSH_AUTHORITY)}=${cookieValue}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
    ],
  });
}

function dshDependencies(fence: DshWebFenceState = { state: 'idle' }) {
  return {
    probeDshWebFence: vi
      .fn<(service: NativeServiceDefinition) => Promise<DshWebFenceState>>()
      .mockResolvedValue(fence),
    probeDshWebAuth: vi
      .fn<(cookie: string) => Promise<DshWebAuthProbeResult>>()
      .mockResolvedValue({ ok: true }),
    dshVersionProbe: vi.fn<() => Promise<string>>().mockResolvedValue('0.2.0-rc.2'),
    dshExchange: fakeDshExchange(),
  };
}

function dshService() {
  const service = createNativeServiceDefinitions().find(({ id }) => id === 'dsh');
  if (!service) throw new Error('Missing dsh service definition.');
  return service;
}

describe('processSupervisor', () => {
  it('uses verified OpenCode, Codex, Kimi Web, and DSH native launch commands', () => {
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
      {
        id: 'dsh',
        name: 'DSH',
        command: 'dsh',
        args: ['web', '--no-open', '--port', '3080'],
        probe: { type: 'http', url: 'http://127.0.0.1:3080/' },
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
      readinessAttempts: 100,
      readinessIntervalMs: 20,
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
      readinessAttempts: 100,
      readinessIntervalMs: 20,
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

  it('reports the drifted port when the startup line arrives after the readiness window', async () => {
    const spawnProcess = fakeKimiSpawn('http://127.0.0.1:58628/#token=secret', 250);
    const supervisor = createProcessSupervisor({
      services: [kimiService()],
      spawnProcess,
      probeKimiWebHealth: vi.fn().mockResolvedValue({ state: 'idle' }),
      ...kimiDependencies(),
      readinessAttempts: 100,
      readinessIntervalMs: 20,
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

describe('processSupervisor dsh web (spawn-only port contract)', () => {
  it('reaches running only after launch line parse, cookie exchange, and authenticated readiness', async () => {
    const spawnProcess = fakeDshSpawn(DSH_LAUNCH_LINE);
    const deps = dshDependencies();
    const supervisor = createProcessSupervisor({
      services: [dshService()],
      spawnProcess,
      ...deps,
      readinessAttempts: 100,
      readinessIntervalMs: 20,
    });

    await supervisor.start();

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess).toHaveBeenCalledWith(
      'dsh',
      ['web', '--no-open', '--port', '3080'],
      expect.any(Object),
    );
    expect(deps.probeDshWebFence).toHaveBeenCalledTimes(1);
    expect(deps.dshVersionProbe).toHaveBeenCalledTimes(1);
    expect(deps.dshExchange).toHaveBeenCalledWith({
      authority: DSH_AUTHORITY,
      launchToken: 'fake-launch-token',
    });
    expect(deps.probeDshWebAuth).toHaveBeenCalledWith(
      `${computeDshAuthCookieName(DSH_AUTHORITY)}=probe-cookie-value`,
    );
    expect(supervisor.getStatus()[0]).toEqual(
      expect.objectContaining({
        id: 'dsh',
        state: 'running',
        owned: true,
        version: '0.2.0-rc.2',
      }),
    );
    const serialized = JSON.stringify(supervisor.getStatus());
    expect(serialized).not.toContain('fake-launch-token');
    expect(serialized).not.toContain('probe-cookie-value');
    await supervisor.stop();
    expectChildStopped(spawnedChildren[0]);
  });

  it('stops the dsh child and never spawns a second one when the cookie exchange fails', async () => {
    const spawnProcess = fakeDshSpawn(DSH_LAUNCH_LINE);
    const deps = dshDependencies();
    deps.dshExchange.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3080'));
    const supervisor = createProcessSupervisor({
      services: [dshService()],
      spawnProcess,
      ...deps,
      readinessAttempts: 100,
      readinessIntervalMs: 20,
    });

    await supervisor.start();

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(deps.probeDshWebAuth).not.toHaveBeenCalled();
    expect(supervisor.getStatus()[0]).toEqual(
      expect.objectContaining({
        state: 'error',
        owned: false,
        error: expect.stringContaining('cookie exchange'),
      }),
    );
    expect(supervisor.getStatus()[0].error).not.toContain('fake-launch-token');
    expectChildStopped(spawnedChildren[0]);
  });

  it('stops the dsh child when the exchange answers without a usable auth cookie', async () => {
    const spawnProcess = fakeDshSpawn(DSH_LAUNCH_LINE);
    const deps = dshDependencies();
    deps.dshExchange.mockResolvedValue({ status: 401, setCookie: [] });
    const supervisor = createProcessSupervisor({
      services: [dshService()],
      spawnProcess,
      ...deps,
      readinessAttempts: 100,
      readinessIntervalMs: 20,
    });

    await supervisor.start();

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(deps.probeDshWebAuth).not.toHaveBeenCalled();
    expect(supervisor.getStatus()[0]).toEqual(
      expect.objectContaining({
        state: 'error',
        owned: false,
        error: expect.stringContaining('no usable auth cookie'),
      }),
    );
    expectChildStopped(spawnedChildren[0]);
  });

  it('stops the dsh child and reports version guidance when dsh is not 0.2.0-rc.2', async () => {
    const spawnProcess = fakeDshSpawn(DSH_LAUNCH_LINE);
    const deps = dshDependencies();
    deps.dshVersionProbe.mockResolvedValue('9.9.9');
    const supervisor = createProcessSupervisor({
      services: [dshService()],
      spawnProcess,
      ...deps,
      readinessAttempts: 100,
      readinessIntervalMs: 20,
    });

    await supervisor.start();

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(deps.dshExchange).not.toHaveBeenCalled();
    const [status] = supervisor.getStatus();
    expect(status).toEqual(
      expect.objectContaining({
        state: 'error',
        owned: false,
        version: '9.9.9',
        error: expect.stringContaining('0.2.0-rc.2'),
      }),
    );
    expect(status.error).toContain('9.9.9');
    expect(status.error).toContain('npm i -g @deepseek-ai/dsh@0.2.0-rc.2');
    expectChildStopped(spawnedChildren[0]);
  });

  it('stops the dsh child when the dsh --version probe itself fails', async () => {
    const spawnProcess = fakeDshSpawn(DSH_LAUNCH_LINE);
    const deps = dshDependencies();
    deps.dshVersionProbe.mockRejectedValue(new Error('spawn dsh ENOENT'));
    const supervisor = createProcessSupervisor({
      services: [dshService()],
      spawnProcess,
      ...deps,
      readinessAttempts: 100,
      readinessIntervalMs: 20,
    });

    await supervisor.start();

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(supervisor.getStatus()[0]).toEqual(
      expect.objectContaining({
        state: 'error',
        owned: false,
        error: expect.stringContaining('npm i -g @deepseek-ai/dsh@0.2.0-rc.2'),
      }),
    );
    expectChildStopped(spawnedChildren[0]);
  });

  it('never reaches running when the authenticated readiness check fails', async () => {
    const spawnProcess = fakeDshSpawn(DSH_LAUNCH_LINE);
    const deps = dshDependencies();
    deps.probeDshWebAuth.mockResolvedValue({
      ok: false,
      reason: 'authenticated account/getState check returned HTTP 401',
    });
    const supervisor = createProcessSupervisor({
      services: [dshService()],
      spawnProcess,
      ...deps,
      readinessAttempts: 100,
      readinessIntervalMs: 20,
    });

    await supervisor.start();

    expect(deps.dshExchange).toHaveBeenCalledTimes(1);
    expect(supervisor.getStatus()[0]).toEqual(
      expect.objectContaining({
        state: 'error',
        owned: false,
        error: expect.stringContaining('401'),
      }),
    );
    expectChildStopped(spawnedChildren[0]);
  });

  it('reports a dsh-occupied port without spawning or adopting the external instance', async () => {
    const spawnProcess = vi.fn();
    const deps = dshDependencies({ state: 'fence' });
    const supervisor = createProcessSupervisor({
      services: [dshService()],
      spawnProcess,
      ...deps,
      readinessAttempts: 2,
      readinessIntervalMs: 0,
    });

    await supervisor.start();

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(deps.dshVersionProbe).not.toHaveBeenCalled();
    expect(deps.dshExchange).not.toHaveBeenCalled();
    const [status] = supervisor.getStatus();
    expect(status).toEqual(
      expect.objectContaining({ state: 'error', owned: false, error: expect.stringContaining('occupied') }),
    );
    expect(status.state).not.toBe('adopted');
  });

  it('reports a non-dsh occupant of port 3080 without spawning', async () => {
    const spawnProcess = vi.fn();
    const deps = dshDependencies({ state: 'mismatch', reason: 'GET / answered HTTP 200' });
    const supervisor = createProcessSupervisor({
      services: [dshService()],
      spawnProcess,
      ...deps,
      readinessAttempts: 2,
      readinessIntervalMs: 0,
    });

    await supervisor.start();

    expect(spawnProcess).not.toHaveBeenCalled();
    const [status] = supervisor.getStatus();
    expect(status).toEqual(
      expect.objectContaining({
        state: 'error',
        owned: false,
        error: expect.stringContaining('not usable DSH'),
      }),
    );
    expect(status.error).toContain('HTTP 200');
  });

  it('reports a missing dsh binary with install guidance', async () => {
    const supervisor = createProcessSupervisor({
      services: [dshService()],
      spawnProcess: vi.fn(() => {
        const child = spawn('vis-definitely-missing-dsh', [], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        spawnedChildren.push(child);
        return child;
      }),
      ...dshDependencies(),
      readinessAttempts: 1,
      readinessIntervalMs: 0,
    });

    await supervisor.start();

    expect(supervisor.getStatus()[0]).toEqual(
      expect.objectContaining({
        id: 'dsh',
        state: 'error',
        owned: false,
        error: expect.stringContaining('npm i -g @deepseek-ai/dsh@0.2.0-rc.2'),
      }),
    );
  });

  it('stops dsh when its startup line reports a drifted port', async () => {
    const spawnProcess = fakeDshSpawn('dsh web: http://127.0.0.1:3081/?token=fake-launch-token');
    const deps = dshDependencies();
    const supervisor = createProcessSupervisor({
      services: [dshService()],
      spawnProcess,
      ...deps,
      readinessAttempts: 100,
      readinessIntervalMs: 20,
    });

    await supervisor.start();

    expect(supervisor.getStatus()[0]).toEqual(
      expect.objectContaining({
        state: 'error',
        owned: false,
        error: expect.stringContaining('3081'),
      }),
    );
    expect(deps.dshExchange).not.toHaveBeenCalled();
    expectChildStopped(spawnedChildren[0]);
  });

  it('stops a dsh child that never prints a launch line before readiness timeout', async () => {
    const spawnProcess = fakeDshSpawn();
    const deps = dshDependencies();
    const supervisor = createProcessSupervisor({
      services: [dshService()],
      spawnProcess,
      ...deps,
      readinessAttempts: 2,
      readinessIntervalMs: 0,
    });

    await supervisor.start();

    expect(deps.dshExchange).not.toHaveBeenCalled();
    expect(supervisor.getStatus()[0]).toEqual(
      expect.objectContaining({
        state: 'error',
        owned: false,
        error: expect.stringContaining('did not become ready'),
      }),
    );
    expectChildStopped(spawnedChildren[0]);
  });
});
