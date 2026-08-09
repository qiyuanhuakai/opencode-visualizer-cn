import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { assertSafeDaemonTarget } from './daemonCredentials.js';

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

Options:
  --target             Upstream Codex app-server WebSocket URL.
  --host               Bridge listen host. Defaults to 127.0.0.1.
  --port               Bridge listen port. Defaults to 23004.
  --path               Local WebSocket path. Defaults to /codex.
  --bridge-token       Optional token required from clients via Authorization Bearer or ?token=.
  --upstream-token     Bearer token sent to Codex app-server during WebSocket handshake.
  --upstream-token-file Read upstream bearer token from file.
  --config             Bridge supervisor config path.
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
  if (explicitCommand && !['start', 'stop', 'restart', '__daemon'].includes(explicitCommand)) {
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
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (command === 'stop') {
    const unexpectedOption = Object.keys(values).find((key) => key !== 'help');
    if (unexpectedOption) throw new Error(`vis_bridge stop does not accept --${unexpectedOption}.`);
    return { command, help: Boolean(values.help), serverArgs: [] };
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
