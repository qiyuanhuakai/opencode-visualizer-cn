import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { createKimiWebTokenProvider } from './kimiWebToken.js';
import { detachedProcessOptions, stopProcessTree } from './processTree.js';

const DEFAULT_READINESS_ATTEMPTS = 20;
const DEFAULT_READINESS_INTERVAL_MS = 250;
const STOP_GRACE_MS = 2_000;
const KIMI_WEB_PORT = 58_627;
const KIMI_WEB_META_URL = `http://127.0.0.1:${KIMI_WEB_PORT}/api/v1/meta`;

export function createNativeServiceDefinitions() {
  return [
    {
      id: 'opencode',
      name: 'OpenCode',
      command: 'opencode',
      args: ['serve', '--hostname', '127.0.0.1', '--port', '4096'],
      probe: { type: 'http', url: 'http://127.0.0.1:4096/global/health' },
    },
    {
      id: 'codex',
      name: 'Codex',
      command: 'codex',
      args: ['app-server', '--listen', 'ws://127.0.0.1:4500'],
      probe: { type: 'tcp', host: '127.0.0.1', port: 4500 },
    },
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
  ];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function matchesExpectedJson(value, expectJson) {
  return Object.entries(expectJson).every(([path, expected]) => {
    const actual = path.split('.').reduce((current, segment) => {
      if (!current || typeof current !== 'object') return undefined;
      return current[segment];
    }, value);
    return actual === expected;
  });
}

async function inspectHttpProbe(probe) {
  try {
    const response = await fetch(probe.url, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) {
      return { reachable: true, matches: false, reason: `HTTP ${response.status}` };
    }
    if (!probe.expectJson) return { reachable: true, matches: true };
    let body;
    try {
      body = await response.json();
    } catch {
      return { reachable: true, matches: false, reason: 'response was not JSON' };
    }
    if (matchesExpectedJson(body, probe.expectJson)) return { reachable: true, matches: true };
    const expectation = Object.entries(probe.expectJson)
      .map(([path, expected]) => `${path}=${JSON.stringify(expected)}`)
      .join(', ');
    return {
      reachable: true,
      matches: false,
      reason: `health response did not match ${expectation}`,
    };
  } catch {
    return { reachable: false, matches: false, reason: 'connection failed' };
  }
}

async function probeHttp(probe) {
  return (await inspectHttpProbe(probe)).matches;
}

async function inspectKimiWebHealth(service) {
  const result = await inspectHttpProbe(service.probe);
  if (!result.reachable) return { state: 'idle' };
  if (result.matches) return { state: 'matching' };
  return { state: 'mismatch', reason: result.reason };
}

async function probeKimiWebAuth(authorization) {
  try {
    const response = await fetch(KIMI_WEB_META_URL, {
      headers: { authorization },
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok
      ? { ok: true }
      : { ok: false, reason: `authenticated meta check returned HTTP ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      reason: `authenticated meta check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function probeTcp(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (available) => {
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(1_000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export function probeNativeService(service) {
  if (service.probe.type === 'http') return probeHttp(service.probe);
  return probeTcp(service.probe.host, service.probe.port);
}

function initialStatus(service) {
  return {
    id: service.id,
    name: service.name,
    kind: 'native',
    command: service.command,
    args: [...service.args],
    state: 'stopped',
    owned: false,
  };
}

export function createProcessSupervisor(options = {}) {
  const services = options.services ?? createNativeServiceDefinitions();
  const spawnProcess = options.spawnProcess ?? spawn;
  const probeService = options.probeService ?? probeNativeService;
  const probeKimiHealth = options.probeKimiWebHealth ?? inspectKimiWebHealth;
  const probeKimiAuth = options.probeKimiWebAuth ?? probeKimiWebAuth;
  const kimiWebTokenProvider = options.kimiWebTokenProvider ?? createKimiWebTokenProvider();
  const readinessAttempts = options.readinessAttempts ?? DEFAULT_READINESS_ATTEMPTS;
  const readinessIntervalMs = options.readinessIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS;
  const statuses = new Map(services.map((service) => [service.id, initialStatus(service)]));
  const children = new Map();

  function getStatus() {
    return services.map((service) => ({ ...statuses.get(service.id), args: [...service.args] }));
  }

  function kimiCredentialError(error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `${reason}. Run \`kimi web\` once manually so ~/.kimi-code/server.token exists and is readable, then retry.`;
  }

  async function stopFailedChild(service, child, error) {
    const status = statuses.get(service.id);
    status.state = 'error';
    status.error = error;
    await stopProcessTree(child, { graceMs: STOP_GRACE_MS });
    if (children.get(service.id) === child) children.delete(service.id);
    status.owned = false;
    delete status.pid;
    status.error = error;
  }

  async function inspectKimiService(service) {
    let authorization;
    try {
      authorization = kimiWebTokenProvider.getAuthorization();
    } catch (error) {
      return { state: 'error', reason: kimiCredentialError(error) };
    }

    const health = await probeKimiHealth(service);
    if (health.state === 'idle') return { state: 'idle' };
    if (health.state === 'mismatch') {
      return {
        state: 'error',
        reason: `Port ${KIMI_WEB_PORT} is occupied but is not usable Kimi Web: ${health.reason}.`,
      };
    }

    const auth = await probeKimiAuth(authorization);
    if (!auth.ok) {
      return { state: 'error', reason: `Kimi Web credential check failed: ${auth.reason}.` };
    }
    return { state: 'usable' };
  }

  async function startService(service) {
    const status = statuses.get(service.id);
    if (status.state === 'running' || status.state === 'adopted' || status.state === 'starting')
      return;
    status.state = 'starting';
    delete status.error;

    if (service.id === 'kimi-web') {
      const inspected = await inspectKimiService(service);
      if (inspected.state === 'usable') {
        status.state = 'adopted';
        status.owned = false;
        return;
      }
      if (inspected.state === 'error') {
        status.state = 'error';
        status.owned = false;
        status.error = inspected.reason;
        return;
      }
    } else if (await probeService(service)) {
      status.state = 'adopted';
      status.owned = false;
      return;
    }

    let child;
    try {
      child = spawnProcess(service.command, service.args, {
        env: process.env,
        stdio:
          service.id === 'kimi-web' ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        ...detachedProcessOptions(),
      });
    } catch (error) {
      status.state = 'error';
      status.error = error instanceof Error ? error.message : String(error);
      return;
    }

    children.set(service.id, child);
    status.owned = true;
    status.pid = child.pid;
    let stderr = '';
    let kimiStdout = '';
    let kimiBoundPort;
    child.stdout?.on('data', (chunk) => {
      if (service.id !== 'kimi-web' || kimiBoundPort !== undefined) return;
      kimiStdout = `${kimiStdout}${String(chunk)}`.slice(-4_096);
      const match = kimiStdout.match(/http:\/\/127\.0\.0\.1:(\d+)\/#token=/);
      if (match) {
        kimiBoundPort = Number(match[1]);
        kimiStdout = '';
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_096);
    });
    child.once('exit', (code, signal) => {
      if (children.get(service.id) !== child) return;
      children.delete(service.id);
      status.owned = false;
      delete status.pid;
      if (status.state === 'stopping') {
        status.state = 'stopped';
        delete status.error;
      } else if (status.state !== 'error') {
        status.state = 'error';
        status.error = stderr.trim() || `${service.name} exited (${signal ?? code ?? 'unknown'}).`;
      }
    });

    const launched = await new Promise((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', (error) => {
        if (children.get(service.id) !== child) return;
        children.delete(service.id);
        status.state = 'error';
        status.owned = false;
        delete status.pid;
        status.error = error.message;
        resolve(false);
      });
    });
    if (!launched) return;
    for (
      let attempt = 0;
      attempt < readinessAttempts && status.state === 'starting';
      attempt += 1
    ) {
      if (service.id === 'kimi-web') {
        if (kimiBoundPort !== undefined && kimiBoundPort !== KIMI_WEB_PORT) {
          await stopFailedChild(
            service,
            child,
            `Kimi Web startup race: spawned child bound port ${kimiBoundPort} instead of required ${KIMI_WEB_PORT}.`,
          );
          return;
        }
        const inspected = await inspectKimiService(service);
        if (inspected.state === 'error') {
          await stopFailedChild(service, child, `Kimi Web startup race: ${inspected.reason}`);
          return;
        }
        if (kimiBoundPort === KIMI_WEB_PORT && inspected.state === 'usable') {
          status.state = 'running';
          return;
        }
      } else if (await probeService(service)) {
        status.state = 'running';
        return;
      }
      if (readinessIntervalMs > 0 && attempt + 1 < readinessAttempts)
        await delay(readinessIntervalMs);
    }
    if (status.state === 'starting') {
      const readinessError = stderr.trim() || `${service.name} did not become ready.`;
      status.state = 'error';
      status.error = readinessError;
      await stopFailedChild(service, child, readinessError);
    }
  }

  async function start() {
    await Promise.all(services.map(startService));
    return getStatus();
  }

  async function stopService(service) {
    const child = children.get(service.id);
    const status = statuses.get(service.id);
    if (!child) {
      if (status.state !== 'adopted') status.state = 'stopped';
      return;
    }
    status.state = 'stopping';
    await stopProcessTree(child, { graceMs: STOP_GRACE_MS });
    if (children.get(service.id) !== child) return;
    children.delete(service.id);
    status.state = 'stopped';
    status.owned = false;
    delete status.pid;
  }

  async function stop() {
    await Promise.all(services.map(stopService));
  }

  return { start, stop, getStatus };
}
