const DAEMON_CREDENTIAL_ENV_NAMES = [
  'VIS_BRIDGE_DAEMON_CONTROL_TOKEN',
  'VIS_BRIDGE_TOKEN',
  'VIS_BRIDGE_CODEX_TOKEN',
  'VIS_BRIDGE_CODEX_TOKEN_FILE',
  'VIS_BRIDGE_CODEX_AUTHORIZATION',
];

export function createDaemonEnvironment(environment, overrides) {
  const result = { ...environment, ...overrides };
  for (const name of DAEMON_CREDENTIAL_ENV_NAMES) delete result[name];
  return result;
}

export function createDaemonSpawnOptions(environment, overrides, logFileDescriptor) {
  return {
    detached: true,
    env: createDaemonEnvironment(environment, overrides),
    stdio: ['ignore', logFileDescriptor, logFileDescriptor, 'ipc'],
    windowsHide: true,
  };
}
