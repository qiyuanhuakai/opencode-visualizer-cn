import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { createKimiWebTokenProvider } from './kimiWebToken.js';
import { createDshAuthProvider, createNodeDshExchange } from './dshAuth.js';
import { detachedProcessOptions, stopProcessTree } from './processTree.js';

const DEFAULT_READINESS_ATTEMPTS = 20;
const DEFAULT_READINESS_INTERVAL_MS = 250;
const STOP_GRACE_MS = 2_000;
const KIMI_WEB_PORT = 58_627;
const KIMI_WEB_META_URL = `http://127.0.0.1:${KIMI_WEB_PORT}/api/v1/meta`;
const DSH_WEB_PORT = 3_080;
const DSH_WEB_AUTHORITY = `127.0.0.1:${DSH_WEB_PORT}`;
const DSH_GET_STATE_URL = `http://127.0.0.1:${DSH_WEB_PORT}/api/account/getState`;
// dsh prints this on stdout once the web server is bound; the `?token=` value
// is the per-process launch token (docs/dsh.md 4.1). NOTE: dsh uses `/?token=`
// while kimi uses `/#token=` — the patterns are deliberately not shared.
const DSH_LAUNCH_LINE_PATTERN = /dsh web: http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/;
const DSH_SUPPORTED_VERSION = '0.2.0-rc.2';
const DSH_INSTALL_GUIDANCE = 'npm i -g @deepseek-ai/dsh@0.2.0-rc.2';
const DSH_VERSION_PROBE_TIMEOUT_MS = 10_000;

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
    // `--no-open` is load-bearing: without it dsh opens a browser on the
    // bridge host on every spawn.
    {
      id: 'dsh',
      name: 'DSH',
      command: 'dsh',
      args: ['web', '--no-open', '--port', String(DSH_WEB_PORT)],
      probe: { type: 'http', url: `http://127.0.0.1:${DSH_WEB_PORT}/` },
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

/**
 * DSH port occupancy check — dsh is spawn-only, there is deliberately no
 * `adopted` state for it.
 *
 * Probe semantic (chosen, with reason): `GET /` WITHOUT credentials, treating
 * HTTP 401 as "a dsh process owns this port". dsh answers 401 when a request
 * carries neither launch token nor auth cookie (docs/dsh.md 4.1, live-verified
 * during the dsh adaptation probe), which identifies an occupant with zero
 * credentials. The alternative — a cookie-authenticated
 * `POST /api/account/getState` expecting ok:true — is impossible for an
 * EXTERNAL instance: the launch token only ever appears on the stdout of the
 * process that printed it, so the bridge can never mint a cookie for an
 * instance it did not spawn. An adopted external dsh would therefore be
 * unforwardable (the proxy would have no cookie), so an occupied port is an
 * error that surfaces to the user instead of an adoption.
 */
async function inspectDshWebFence(service) {
  try {
    const response = await fetch(service.probe.url, { signal: AbortSignal.timeout(1_000) });
    if (response.status === 401) return { state: 'fence' };
    return { state: 'mismatch', reason: `GET / answered HTTP ${response.status}` };
  } catch {
    return { state: 'idle' };
  }
}

/**
 * Authenticated readiness check for the bridge-owned dsh child: the cookie
 * minted from the child's launch token must satisfy dsh's own session fence.
 * `account/getState` is the cheapest unary RPC (docs/dsh.md 5.1/7, probed
 * live: `{args:{}}` payload, `{ok:true,value}` result). No Origin header is
 * sent: non-browser clients only need a loopback Host plus the cookie
 * (docs/dsh.md 4.2).
 */
async function probeDshWebAuth(cookie) {
  try {
    const response = await fetch(DSH_GET_STATE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'dsh-bridge-readiness',
        method: 'account/getState',
        payload: { args: {} },
      }),
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: `authenticated account/getState check returned HTTP ${response.status}`,
      };
    }
    let body;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: 'account/getState response was not JSON' };
    }
    if (body?.result?.ok === true) return { ok: true };
    const code = body?.result?.error?.code;
    return {
      ok: false,
      reason: code
        ? `account/getState rejected the exchanged cookie (${code})`
        : 'account/getState response did not carry ok:true',
    };
  } catch (error) {
    return {
      ok: false,
      reason: `authenticated account/getState check failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/** Version gate: resolve the installed dsh protocol generation. */
function probeDshCliVersion() {
  return new Promise((resolve, reject) => {
    const child = spawn('dsh', ['--version'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (finish) => {
      if (settled) return;
      settled = true;
      finish();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      settle(() =>
        reject(new Error(`dsh --version did not answer within ${DSH_VERSION_PROBE_TIMEOUT_MS}ms`)),
      );
    }, DSH_VERSION_PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-4_096);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_096);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      settle(() => reject(error));
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      const match = stdout.match(/\d+\.\d+\.\d+[^\s]*/);
      settle(() => {
        if (code === 0 && match) resolve(match[0]);
        else
          reject(
            new Error(
              `dsh --version exited with code ${code ?? 'unknown'}${
                stderr.trim() ? `: ${stderr.trim()}` : ''
              }`,
            ),
          );
      });
    });
  });
}

/** ENOENT means dsh is not installed (or not on PATH) — make it actionable. */
function dshStartupError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.code === 'ENOENT') {
    return `${message}. Install the supported protocol generation: ${DSH_INSTALL_GUIDANCE}.`;
  }
  return message;
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
  const probeDshFence = options.probeDshWebFence ?? inspectDshWebFence;
  const probeDshAuth = options.probeDshWebAuth ?? probeDshWebAuth;
  const dshVersionProbe = options.dshVersionProbe ?? probeDshCliVersion;
  // The launch token only exists on the stdout of the dsh child THIS supervisor
  // spawns, so the supervisor owns it and hands out a cookie provider for the
  // bridge proxies (dsh is spawn-only: an external instance cannot be adopted
  // or authenticated).
  const dshStartup = { port: undefined, token: null };
  const dshAuthProvider = createDshAuthProvider({
    exchange: options.dshExchange ?? createNodeDshExchange(),
    getLaunchToken: () => dshStartup.token,
  });
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

    if (service.id === 'dsh') {
      const fence = await probeDshFence(service);
      if (fence.state === 'fence') {
        status.state = 'error';
        status.owned = false;
        status.error = `Port ${DSH_WEB_PORT} is occupied by a dsh web instance this bridge cannot supervise: the launch token needed for the cookie exchange exists only on that process's stdout, so an external dsh can never be authenticated here. Stop the external dsh instance (or let the bridge host it) and retry.`;
        return;
      }
      if (fence.state === 'mismatch') {
        status.state = 'error';
        status.owned = false;
        status.error = `Port ${DSH_WEB_PORT} is occupied but is not usable DSH: ${fence.reason}.`;
        return;
      }
    } else if (service.id === 'kimi-web') {
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
    const needsStdout = service.id === 'kimi-web' || service.id === 'dsh';
    if (service.id === 'dsh') {
      dshStartup.port = undefined;
      dshStartup.token = null;
    }
    try {
      child = spawnProcess(service.command, service.args, {
        env: process.env,
        stdio: needsStdout ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'],
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
    let dshStdout = '';
    child.stdout?.on('data', (chunk) => {
      if (service.id === 'kimi-web') {
        if (kimiBoundPort !== undefined) return;
        kimiStdout = `${kimiStdout}${String(chunk)}`.slice(-4_096);
        const match = kimiStdout.match(/http:\/\/127\.0\.0\.1:(\d+)\/#token=/);
        if (match) {
          kimiBoundPort = Number(match[1]);
          kimiStdout = '';
        }
        return;
      }
      if (service.id === 'dsh' && dshStartup.port === undefined) {
        dshStdout = `${dshStdout}${String(chunk)}`.slice(-4_096);
        const match = dshStdout.match(DSH_LAUNCH_LINE_PATTERN);
        if (match) {
          dshStartup.port = Number(match[1]);
          dshStartup.token = match[2];
          dshStdout = '';
        }
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
        status.error = service.id === 'dsh' ? dshStartupError(error) : error.message;
        resolve(false);
      });
    });
    if (!launched) return;

    if (service.id === 'dsh') {
      // Version gate first: a wrong protocol generation must never reach the
      // exchange or the authenticated readiness check.
      let version;
      try {
        version = await dshVersionProbe();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await stopFailedChild(
          service,
          child,
          `DSH version check failed: ${reason}. Install the supported protocol generation: ${DSH_INSTALL_GUIDANCE}.`,
        );
        return;
      }
      status.version = version;
      if (version !== DSH_SUPPORTED_VERSION) {
        await stopFailedChild(
          service,
          child,
          `DSH protocol generation mismatch: expected dsh@${DSH_SUPPORTED_VERSION}, found ${version}. Install the matching version (${DSH_INSTALL_GUIDANCE}) or wait for the bridge adapter to support it.`,
        );
        return;
      }
    }

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
      } else if (service.id === 'dsh') {
        if (dshStartup.port !== undefined && dshStartup.port !== DSH_WEB_PORT) {
          await stopFailedChild(
            service,
            child,
            `DSH startup race: spawned child bound port ${dshStartup.port} instead of required ${DSH_WEB_PORT}.`,
          );
          return;
        }
        if (dshStartup.port === DSH_WEB_PORT) {
          // Cold-start order is load-bearing: launch line parsed (port + token)
          // -> exchange the token for a cookie -> authenticated readiness ->
          // running. The cookie can only come from the child this supervisor
          // spawned, so there is never a "running without credentials" path.
          let cookie;
          try {
            cookie = await dshAuthProvider.getCookie(DSH_WEB_AUTHORITY);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            await stopFailedChild(
              service,
              child,
              `DSH launch-token cookie exchange failed: ${reason}.`,
            );
            return;
          }
          const auth = await probeDshAuth(cookie);
          if (!auth.ok) {
            await stopFailedChild(
              service,
              child,
              `DSH authenticated readiness check failed: ${auth.reason}.`,
            );
            return;
          }
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

  async function start(enabledServices = {}) {
    await Promise.all(services.map((service) => {
      if (enabledServices[service.id] !== false) return startService(service);
      const status = statuses.get(service.id);
      status.state = 'disabled';
      status.owned = false;
      delete status.error;
      return undefined;
    }));
    return getStatus();
  }

  async function stopService(service) {
    const child = children.get(service.id);
    const status = statuses.get(service.id);
    if (!child) {
      if (status.state !== 'adopted' && status.state !== 'disabled') status.state = 'stopped';
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

  return { start, stop, getStatus, getDshAuthProvider: () => dshAuthProvider };
}
