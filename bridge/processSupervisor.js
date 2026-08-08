import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { detachedProcessOptions, stopProcessTree } from './processTree.js';

const DEFAULT_READINESS_ATTEMPTS = 20;
const DEFAULT_READINESS_INTERVAL_MS = 250;
const STOP_GRACE_MS = 2_000;

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
  ];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function probeHttp(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
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
  if (service.probe.type === 'http') return probeHttp(service.probe.url);
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
  const readinessAttempts = options.readinessAttempts ?? DEFAULT_READINESS_ATTEMPTS;
  const readinessIntervalMs = options.readinessIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS;
  const statuses = new Map(services.map((service) => [service.id, initialStatus(service)]));
  const children = new Map();

  function getStatus() {
    return services.map((service) => ({ ...statuses.get(service.id), args: [...service.args] }));
  }

  async function startService(service) {
    const status = statuses.get(service.id);
    if (status.state === 'running' || status.state === 'adopted' || status.state === 'starting') return;
    status.state = 'starting';
    delete status.error;

    if (await probeService(service)) {
      status.state = 'adopted';
      status.owned = false;
      return;
    }

    let child;
    try {
      child = spawnProcess(service.command, service.args, {
        env: process.env,
        stdio: ['ignore', 'ignore', 'pipe'],
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
    for (let attempt = 0; attempt < readinessAttempts && status.state === 'starting'; attempt += 1) {
      if (await probeService(service)) {
        status.state = 'running';
        return;
      }
      if (readinessIntervalMs > 0 && attempt + 1 < readinessAttempts) await delay(readinessIntervalMs);
    }
    if (status.state === 'starting') {
      status.state = 'error';
      status.error = stderr.trim() || `${service.name} did not become ready.`;
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
