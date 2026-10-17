import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createBridgeConfigStore } from './bridgeConfig.js';
import { createDaemonPaths, isProcessAlive, readDaemonState } from './daemonState.js';
import { assertSafeDaemonTarget } from './daemonCredentials.js';
import { parseEnvironmentId } from '../shared/runtime/identity.js';

const DEFAULT_PORT = 23004;
const DEFAULT_PATH = '/codex';
const DAEMON_CONFIGURATION_ENV_NAMES = [
  'VIS_BRIDGE_HOST',
  'VIS_BRIDGE_PORT',
  'VIS_BRIDGE_PATH',
  'VIS_BRIDGE_CODEX_WS_URL',
  'VIS_BRIDGE_CONFIG',
];
const DEFAULT_CODEX_WS_URL = 'ws://127.0.0.1:4500';

export function usage() {
  return `vis_bridge - local supervisor and protocol bridge for OpenCode, Codex, and ACP agents

Usage:
  vis_bridge start [options]
  vis_bridge stop
  vis_bridge restart [options]
  vis_bridge config [--config <path>]
  vis_bridge control-store --state-root <dir> [--environment <uuid>]
  vis_bridge relay --environment <uuid> --job <uuid> --bridge-instance <uuid> --compute-node <name> (--socket <path>|--port <n>) [--step <uuid>] [--epoch <n>] [--stdio-forward]
  vis_bridge update [--check] [--yes|-y]
  vis_bridge upgrade [--check] [--yes|-y]
  vis_bridge --version

Options:
  --target             Upstream Codex app-server WebSocket URL.
  --host               Bridge listen host. Defaults to 127.0.0.1.
  --port               Bridge listen port. Defaults to 23004.
  --path               Local WebSocket path. Defaults to /codex.
  --bridge-token       Optional token required from clients via Authorization Bearer or ?token=.
  --upstream-token     Bearer token sent to Codex app-server during WebSocket handshake.
  --upstream-token-file Read upstream bearer token from file.
  --config             Bridge supervisor config path.
  --state-root         Login-local state root owned by the control-store role.
  --environment        Persistent cluster environment UUID the control store fences.
  --job                Slurm intent UUID the relay belongs to (relay role).
  --bridge-instance    Compute Bridge instance UUID currently serving the job (relay role).
  --compute-node       Verified compute node the relay is bound to (relay role).
  --socket             Compute-local socket path the relay listens on (relay role, no compute TCP).
  --stdio-forward      Forward this process's stdio to the compute-local socket (the srun relay step).
  --port               Authenticated local TCP port the relay listens on (relay role).
  --step               Relay step UUID (relay role; generated when omitted).
  --epoch              Control-store fencing epoch the relay binds (relay role; default 0).
  --help               Show this help.

Environment:
  VIS_BRIDGE_CODEX_WS_URL           Same as --target.
  VIS_BRIDGE_HOST                   Same as --host.
  VIS_BRIDGE_PORT                   Same as --port.
  VIS_BRIDGE_PATH                   Same as --path.
  VIS_BRIDGE_TOKEN                  Same as --bridge-token.
  VIS_BRIDGE_CODEX_TOKEN            Same as --upstream-token.
  VIS_BRIDGE_CODEX_TOKEN_FILE       Same as --upstream-token-file.
  VIS_BRIDGE_CODEX_AUTHORIZATION    Raw Authorization header for upstream.
  VIS_BRIDGE_CONFIG                 Same as --config.
  VIS_BRIDGE_CONTROL_STORE_ROOT     Same as --state-root for the control-store role.
  VIS_BRIDGE_ENVIRONMENT            Same as --environment.
  EDITOR                            Editor command used by vis_bridge config.
  VIS_BRIDGE_STATE_DIR              Override the per-user daemon state directory.
`;
}

function normalizePath(path) {
  if (!path) return DEFAULT_PATH;
  return path.startsWith('/') ? path : `/${path}`;
}

function bearerAuthorization(token) {
  return token ? `Bearer ${token}` : undefined;
}

function createDaemonSecretArgs(options) {
  return [
    ...(options.bridgeToken ? ['--bridge-token=ipc'] : []),
    ...(options.upstreamTokenFile
      ? [`--upstream-token-file=${options.upstreamTokenFile}`]
      : options.upstreamAuthorization
        ? ['--upstream-token=ipc']
        : []),
  ];
}

function createDaemonArgs(options) {
  return [
    `--host=${options.host}`,
    `--port=${options.port}`,
    `--path=${options.path}`,
    `--target=${options.target}`,
    ...(options.configPath ? [`--config=${options.configPath}`] : []),
    ...createDaemonSecretArgs(options),
  ];
}

export function parseCliOptions(argv = process.argv.slice(2), env = process.env) {
  const explicitCommand = argv[0]?.startsWith('-') ? undefined : argv[0];
  if (explicitCommand && !['start', 'stop', 'restart', 'config', 'control-store', 'relay', '__daemon'].includes(explicitCommand)) {
    throw new Error(`Unknown vis_bridge command: ${explicitCommand}`);
  }
  const command = explicitCommand ?? 'start';
  const serverArgs = explicitCommand ? argv.slice(1) : argv;
  const { values } = parseArgs({
    args: serverArgs,
    options: {
      target: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      path: { type: 'string' },
      'bridge-token': { type: 'string' },
      'upstream-token': { type: 'string' },
      'upstream-token-file': { type: 'string' },
      config: { type: 'string' },
      'state-root': { type: 'string' },
      environment: { type: 'string' },
      job: { type: 'string' },
      'bridge-instance': { type: 'string' },
      'compute-node': { type: 'string' },
      socket: { type: 'string' },
      step: { type: 'string' },
      epoch: { type: 'string' },
      'stdio-forward': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (command === 'stop') {
    const unexpectedOption = Object.keys(values).find((key) => key !== 'help');
    if (unexpectedOption) throw new Error(`vis_bridge stop does not accept --${unexpectedOption}.`);
    return { command, help: Boolean(values.help), serverArgs: [] };
  }

  if (command === 'config') {
    const unexpectedOption = Object.keys(values).find((key) => key !== 'help' && key !== 'config');
    if (unexpectedOption) throw new Error(`vis_bridge config does not accept --${unexpectedOption}.`);
    if (values.config !== undefined && !values.config.trim()) {
      throw new Error('vis_bridge config path must not be empty.');
    }
    return {
      command,
      help: Boolean(values.help),
      configPath: values.config ?? (env.VIS_BRIDGE_CONFIG?.trim() || undefined),
    };
  }

  if (command === 'control-store') {
    const unexpectedOption = Object.keys(values).find(
      (key) => !['help', 'state-root', 'environment'].includes(key),
    );
    if (unexpectedOption) throw new Error(`vis_bridge control-store does not accept --${unexpectedOption}.`);
    const stateRoot =
      values['state-root'] ?? env.VIS_BRIDGE_CONTROL_STORE_ROOT?.trim() ?? env.VIS_BRIDGE_STATE_DIR?.trim();
    if (!values.help && !stateRoot) {
      throw new Error('vis_bridge control-store requires --state-root or VIS_BRIDGE_CONTROL_STORE_ROOT.');
    }
    const environmentText = values.environment ?? env.VIS_BRIDGE_ENVIRONMENT;
    let environmentId;
    if (environmentText !== undefined) {
      try {
        environmentId = parseEnvironmentId(environmentText);
      } catch {
        throw new Error(`Invalid vis_bridge control-store environment: ${environmentText}`);
      }
    }
    return {
      command,
      role: 'control-store',
      help: Boolean(values.help),
      serverArgs: [],
      ...(stateRoot === undefined ? {} : { stateRoot }),
      ...(environmentId === undefined ? {} : { environmentId }),
    };
  }

  if (command === 'relay') {
    const unexpectedOption = Object.keys(values).find(
      (key) =>
        ![
          'help',
          'environment',
          'job',
          'bridge-instance',
          'compute-node',
          'socket',
          'step',
          'epoch',
          'host',
          'port',
          'stdio-forward',
        ].includes(key),
    );
    if (unexpectedOption) throw new Error(`vis_bridge relay does not accept --${unexpectedOption}.`);
    const environmentText = values.environment ?? env.VIS_BRIDGE_ENVIRONMENT;
    let environmentId;
    if (!values.help || environmentText !== undefined) {
      if (environmentText === undefined) throw new Error('vis_bridge relay requires --environment <uuid>.');
      try {
        environmentId = parseEnvironmentId(environmentText);
      } catch {
        throw new Error(`Invalid vis_bridge relay environment: ${environmentText}`);
      }
    }
    const socketPath = values.socket ?? env.VIS_BRIDGE_RELAY_SOCKET?.trim() ?? undefined;
    const portText = values.port ?? env.VIS_BRIDGE_RELAY_PORT;
    let port;
    if (portText !== undefined) {
      port = Number.parseInt(String(portText), 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        throw new Error(`Invalid vis_bridge relay port: ${portText}`);
      }
    }
    if (!values.help) {
      if (!values.job) throw new Error('vis_bridge relay requires --job <uuid>.');
      if (!values['bridge-instance']) throw new Error('vis_bridge relay requires --bridge-instance <uuid>.');
      if (!values['compute-node']) throw new Error('vis_bridge relay requires --compute-node <name>.');
      if (values['stdio-forward'] === true && socketPath === undefined) {
        throw new Error('vis_bridge relay --stdio-forward requires --socket <path> (the compute-local socket).');
      }
      if (socketPath === undefined && port === undefined) {
        throw new Error('vis_bridge relay requires --socket <path> or --port <n>.');
      }
    }
    let epoch = 0;
    if (values.epoch !== undefined) {
      epoch = Number.parseInt(values.epoch, 10);
      if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error(`Invalid vis_bridge relay epoch: ${values.epoch}`);
    }
    return {
      command,
      role: 'relay',
      help: Boolean(values.help),
      serverArgs: [],
      stdioForward: values['stdio-forward'] === true,
      ...(environmentId === undefined ? {} : { environmentId }),
      ...(values.job === undefined ? {} : { intentId: values.job }),
      ...(values['bridge-instance'] === undefined ? {} : { bridgeInstanceId: values['bridge-instance'] }),
      ...(values['compute-node'] === undefined ? {} : { computeNode: values['compute-node'] }),
      ...(values.step === undefined ? {} : { stepId: values.step }),
      ...(socketPath === undefined ? {} : { socketPath }),
      ...(port === undefined ? {} : { port }),
      ...(values.host === undefined ? {} : { host: values.host }),
      epoch,
    };
  }

  const tokenFile = values['upstream-token-file'] ?? env.VIS_BRIDGE_CODEX_TOKEN_FILE;
  const directAuthorization = env.VIS_BRIDGE_CODEX_AUTHORIZATION;
  const directToken = values['upstream-token'] ?? env.VIS_BRIDGE_CODEX_TOKEN;
  const tokenFromFile =
    !values.help && !directAuthorization && !directToken && tokenFile
      ? readFileSync(tokenFile, 'utf8').trim()
      : undefined;
  const upstreamTokenFile = !directAuthorization && !directToken ? tokenFile : undefined;
  const portText = values.port ?? env.VIS_BRIDGE_PORT ?? String(DEFAULT_PORT);
  const port = Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid vis_bridge port: ${portText}`);
  }

  const target = values.target ?? env.VIS_BRIDGE_CODEX_WS_URL ?? DEFAULT_CODEX_WS_URL;
  assertSafeDaemonTarget(target);
  const parsed = {
    command,
    help: Boolean(values.help),
    serverArgs: values.help ? [] : serverArgs,
    host: values.host ?? env.VIS_BRIDGE_HOST ?? '127.0.0.1',
    port,
    path: normalizePath(values.path ?? env.VIS_BRIDGE_PATH ?? DEFAULT_PATH),
    target,
    bridgeToken: values['bridge-token'] ?? env.VIS_BRIDGE_TOKEN,
    upstreamAuthorization:
      directAuthorization ?? bearerAuthorization(directToken ?? tokenFromFile),
    upstreamTokenFile,
    configPath: values.config ?? env.VIS_BRIDGE_CONFIG,
  };
  return {
    ...parsed,
    daemonArgs: values.help ? [] : createDaemonArgs(parsed),
    daemonSecretArgs: values.help ? [] : createDaemonSecretArgs(parsed),
    hasDaemonConfiguration:
      ['target', 'host', 'port', 'path', 'config'].some((name) => values[name] !== undefined) ||
      DAEMON_CONFIGURATION_ENV_NAMES.some((name) => typeof env[name] === 'string'),
  };
}

function parseEditorCommand(value) {
  const tokens = [];
  let token = '';
  let quoted;
  let started = false;
  for (const character of value) {
    if (quoted) {
      if (character === quoted) quoted = undefined;
      else token += character;
    } else if (character === '"' || character === "'") {
      quoted = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) tokens.push(token);
      token = '';
      started = false;
    } else {
      token += character;
      started = true;
    }
  }
  if (quoted) throw new Error('EDITOR contains an unmatched quote.');
  if (started) tokens.push(token);
  if (!tokens[0]) throw new Error('EDITOR must name an executable.');
  return tokens;
}

export async function runBridgeConfigCommand(options, env = process.env) {
  const editor = env.EDITOR?.trim();
  if (!editor) throw new Error('EDITOR is not set. Set EDITOR to a terminal editor or an editor command.');
  const [command, ...args] = parseEditorCommand(editor);
  let configPath = options.configPath;
  if (!configPath) {
    const daemon = await readDaemonState(createDaemonPaths(env));
    if (daemon?.state === 'running' && isProcessAlive(daemon.pid)) {
      const configOption = daemon.launchArgs.find((argument) => argument.startsWith('--config='));
      const separatedIndex = daemon.launchArgs.indexOf('--config');
      configPath = configOption?.slice('--config='.length) ||
        (separatedIndex >= 0 ? daemon.launchArgs[separatedIndex + 1] : undefined);
    }
  }
  const store = createBridgeConfigStore({ configPath });
  try {
    await access(store.configPath);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
    await store.load();
  }
  await new Promise((resolve, reject) => {
    const child = spawn(command, [...args, store.configPath], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`EDITOR exited with ${signal ?? `code ${code}`}.`));
    });
  });
  console.log(`Config saved at ${store.configPath}. Run vis_bridge restart to apply service changes.`);
}

/** Node's maximum timer delay; the referenced handle keeps the event loop alive indefinitely. */
const LIVENESS_HEARTBEAT_MS = 2_147_483_647;

/**
 * Explicit, closable process-liveness token for the long-lived lifecycle roles. Registering a
 * SIGINT/SIGTERM listener alone does NOT keep Node's event loop alive, so a command that only
 * listens for signals exits as soon as `main` returns. One referenced timer is an event-loop
 * handle that keeps the process resident until the role calls `release()`, after which the loop
 * can drain and the process exits normally. `release()` is idempotent.
 */
function createLivenessToken() {
  const timer = setInterval(() => {
    // Intentionally empty: the referenced timer itself is the liveness handle.
  }, LIVENESS_HEARTBEAT_MS);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      clearInterval(timer);
    },
  };
}

/**
 * Runs the login-side control-store role: opens the durable Slurm control store on the
 * login-local disk (verifying local FS + acquiring the single-owner fence) and holds it
 * until SIGINT/SIGTERM. The compute Runtime never writes here directly; it reaches this
 * store through the login-owned relay (task 29).
 *
 * Liveness is an explicit referenced timer (not an accidental open handle): without it the
 * process would exit immediately after claiming ownership, since a signal listener does not
 * keep the event loop alive. Every terminating path (SIGINT, SIGTERM, an unexpected error, or
 * an explicit `close()`) releases the on-disk fence before the process ends.
 *
 * The store writes its fence before the open completes (the journal fsync that finishes the
 * open lands after `writeFence`), and `close()` is a no-op until the open has finished. A
 * signal can therefore arrive while the fence is on disk but the store is still opening, so
 * shutdown settles the pending open before releasing: only a `close()` that actually ran
 * counts as a successful release, and an open that failed during shutdown exits non-zero
 * instead of claiming one.
 */
export async function runControlStoreCommand(options, dependencies = {}) {
  const stateRoot = options.stateRoot ?? dependencies.stateRoot;
  if (!stateRoot) throw new Error('vis_bridge control-store requires --state-root or VIS_BRIDGE_CONTROL_STORE_ROOT.');
  const environmentId = options.environmentId ?? dependencies.environmentId;
  if (!environmentId) throw new Error('vis_bridge control-store requires an environment id (--environment).');

  // Loaded before any listener is installed: the module load touches no disk, so a signal
  // during it takes the default disposition with nothing acquired yet, and no shutdown path
  // can race an open that has not been started.
  const { createSlurmControlStore } = await import('./runtime/transports/slurmControlStore.js');

  // Installed before the first disk-touching await: a signal landing while the store is still
  // opening would otherwise take the default disposition and kill the process with the fence
  // held.
  /** @type {{ store?: { close(): Promise<unknown> }, opening?: Promise<unknown>, liveness?: { release(): void }, released: boolean, exiting: boolean }} */
  const role = { store: undefined, opening: undefined, liveness: undefined, released: false, exiting: false };
  const onSignal = () => exitAfterRelease(0);
  const onFatalError = (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    exitAfterRelease(1);
  };
  const onUnhandledRejection = (reason) => {
    console.error(reason instanceof Error ? reason.message : String(reason));
    exitAfterRelease(1);
  };
  const removeProcessListeners = () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('uncaughtException', onFatalError);
    process.off('unhandledRejection', onUnhandledRejection);
  };
  const releaseFence = async () => {
    if (role.released) return;
    role.released = true;
    role.liveness?.release();
    // The fence is already on disk while the open is still finishing its journal fsync, and
    // close() is a no-op until the open completes: settling the pending open first is what
    // makes the close below a real release instead of a success reported without one.
    try {
      await role.opening;
    } catch (error) {
      throw new Error(
        `control-store open failed during shutdown, the fence was not released: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await role.store?.close();
  };
  const exitAfterRelease = (code) => {
    if (role.exiting) return;
    role.exiting = true;
    void releaseFence().then(
      () => process.exit(code),
      (error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      },
    );
  };
  const close = async () => {
    removeProcessListeners();
    await releaseFence();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('uncaughtException', onFatalError);
  process.on('unhandledRejection', onUnhandledRejection);

  const store = createSlurmControlStore({
    root: stateRoot,
    environmentId,
    ownerInstanceId: dependencies.ownerInstanceId ?? `control-store-${process.pid}`,
  });
  role.store = store;
  // Captured synchronously so a signal arriving mid-open awaits this exact open.
  role.opening = store.open('owner');
  let status;
  try {
    status = await role.opening;
  } catch (error) {
    // The open failed after this process installed its listeners; an in-process caller that
    // retries would otherwise inherit listeners that exit the process on the first signal.
    removeProcessListeners();
    throw error;
  }
  if (role.exiting) {
    // Shutdown began while the open was in flight: the pending release is already awaiting
    // this open and will close the store, so do not publish ready or hold the loop open.
    return { store, close };
  }
  console.log(
    `vis_bridge control-store owns environment ${status.environmentId} at ${status.root} (epoch ${status.epoch}).`,
  );
  role.liveness = createLivenessToken();

  return {
    store,
    /**
     * Releases ownership (writes the fence with `released: true`) and stops holding the event
     * loop open. Signal-driven exits call this internally; an in-process caller uses it to
     * relinquish the role without a signal.
     */
    close,
  };
}

/**
 * Runs the compute-side relay role: holds the login-owned long-term relay open (an authenticated
 * TCP listener or a compute-local socket) for the live job + bridge instance. A client disconnect
 * removes only that connection; the relay and the job stay alive until SIGINT/SIGTERM.
 *
 * With `--stdio-forward` the process is the `srun` relay step instead: it connects to the
 * compute-local socket the long-term relay listens on and pipes its own stdio to it, so the
 * framed bytes travel over the step's pipes. stdout carries protocol bytes only — every
 * diagnostic goes to stderr — because the login side decodes the binary handshake off stdout.
 */
export async function runRelayCommand(options, dependencies = {}) {
  if (options.stdioForward === true) return runRelayStdioCommand(options, dependencies);
  const socketPath = options.socketPath ?? dependencies.socketPath;
  const port = options.port ?? dependencies.port;
  if (!socketPath && port === undefined) throw new Error('vis_bridge relay requires --socket <path> or --port <n>.');
  const environmentId = options.environmentId ?? dependencies.environmentId;
  if (!environmentId) throw new Error('vis_bridge relay requires an environment id (--environment).');
  if (!options.intentId) throw new Error('vis_bridge relay requires --job (the job intent UUID).');
  if (!options.bridgeInstanceId) throw new Error('vis_bridge relay requires --bridge-instance.');
  if (!options.computeNode) throw new Error('vis_bridge relay requires --compute-node.');
  const { createComputeRelay } = await import('./runtime/transports/computeRelay.js');
  const { createRelayBinding, createRelayHandshake } = await import('./runtime/transports/relayHandshake.js');
  const binding = createRelayBinding({
    environmentId,
    intentId: options.intentId,
    bridgeInstanceId: options.bridgeInstanceId,
    epoch: options.epoch ?? 0,
    computeNode: options.computeNode,
    stepId: options.stepId ?? dependencies.stepId ?? randomUUID(),
  });
  const credential = options.credential ?? dependencies.credential ?? process.env.VIS_BRIDGE_RELAY_CREDENTIAL ?? '';
  const relay = createComputeRelay({
    handshake: createRelayHandshake({ credential, binding }),
    mode: socketPath ? 'local-socket' : 'tcp',
    ...(socketPath ? { socketPath } : {}),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(port === undefined ? {} : { port }),
  });
  const address = await relay.listen();
  const location = address.mode === 'tcp' ? `${address.host}:${address.port}` : address.path;
  console.log(`vis_bridge relay listening (${address.mode}) for job ${binding.intentId} at ${location} (epoch ${binding.epoch}).`);
  const shutdown = () => {
    void relay.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return relay;
}

/**
 * The `srun` relay step's entry: connects this process's stdio to the compute-local socket the
 * long-term relay already listens on and pipes bytes both ways. The credential proof is
 * end-to-end between the login channel and that relay, so this forwarder never needs the
 * credential. stdout stays protocol-bytes-only (diagnostics on stderr); the process exits when
 * the socket or the stdin pipe closes, and a connect failure exits non-zero with the cause.
 */
export async function runRelayStdioCommand(options, dependencies = {}) {
  const socketPath = options.socketPath ?? dependencies.socketPath;
  if (!socketPath) throw new Error('vis_bridge relay --stdio-forward requires --socket <path>.');
  const { connect } = await import('node:net');
  const socket = connect(socketPath);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', (error) => reject(new Error(`vis_bridge relay --stdio-forward cannot reach ${socketPath}: ${error.message}`)));
  });
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  const shutdown = (code) => {
    socket.destroy();
    process.exit(code);
  };
  socket.on('error', () => shutdown(1));
  socket.on('close', () => shutdown(0));
  process.stdin.on('end', () => socket.end());
  process.stdin.on('error', () => shutdown(1));
  return new Promise(() => {});
}
