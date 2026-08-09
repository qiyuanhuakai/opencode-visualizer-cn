import { createHmac } from 'node:crypto';

const SECRET_OPTIONS = new Map([
  ['--bridge-token', 'bridgeToken'],
  ['--upstream-token', 'upstreamAuthorization'],
]);
const SECRET_OPTION_NAMES = new Map(
  [...SECRET_OPTIONS].map(([optionName, secretName]) => [secretName, optionName]),
);

function optionName(argument) {
  return argument.split('=', 1)[0];
}

function isUpstreamCredentialOption(name) {
  return name === '--upstream-token' || name === '--upstream-token-file';
}

export function assertSafeDaemonTarget(target) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error('Invalid vis_bridge target URL.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      'vis_bridge target URL must not include credentials, query parameters, or fragments; use upstream token options.',
    );
  }
}

export function assertSafeDaemonLaunchArgs(serverArgs) {
  for (let index = 0; index < serverArgs.length; index += 1) {
    const argument = serverArgs[index];
    if (argument === '--target') assertSafeDaemonTarget(serverArgs[index + 1] ?? '');
    else if (argument.startsWith('--target=')) assertSafeDaemonTarget(argument.slice(9));
  }
}

export function assertRequiredDaemonCredentials(
  requiredSecrets = [],
  credentials = {},
  requestedArgs = [],
) {
  const replacesUpstream = requestedArgs.some((argument) =>
    isUpstreamCredentialOption(optionName(argument)));
  if (requiredSecrets.some((name) =>
    typeof credentials[name] !== 'string' && !(name === 'upstreamAuthorization' && replacesUpstream))) {
    throw new Error(
      'vis_bridge restart requires the original direct token options; use token files or environment variables for unattended restarts.',
    );
  }
}

export function mergeDaemonRestartArgs(previousArgs, requestedArgs, requiredSecrets = []) {
  if (requestedArgs.length === 0) {
    return [
      ...previousArgs,
      ...requiredSecrets.map((name) => `${SECRET_OPTION_NAMES.get(name)}=ipc`),
    ];
  }
  const requestedNames = requestedArgs.map(optionName);
  if (!requestedNames.every((name) => SECRET_OPTIONS.has(name) || name === '--upstream-token-file')) {
    return [...requestedArgs];
  }
  const replacesUpstream = requestedNames.some(isUpstreamCredentialOption);
  const retainedArgs = previousArgs.filter((argument) =>
    !(replacesUpstream && isUpstreamCredentialOption(optionName(argument))));
  const retainedSecretMarkers = requiredSecrets
    .filter((name) =>
      !requestedNames.includes(SECRET_OPTION_NAMES.get(name)) &&
      !(name === 'upstreamAuthorization' && replacesUpstream))
    .map((name) => `${SECRET_OPTION_NAMES.get(name)}=ipc`);
  return [...retainedArgs, ...retainedSecretMarkers, ...requestedArgs];
}

export function prepareDaemonLaunch(serverArgs, credentials = {}) {
  const launchArgs = [];
  const secrets = {};
  const requiredSecrets = [];
  for (let index = 0; index < serverArgs.length; index += 1) {
    const argument = serverArgs[index];
    const name = optionName(argument);
    const secretName = SECRET_OPTIONS.get(name);
    if (!secretName) {
      launchArgs.push(argument);
      continue;
    }
    if (!argument.includes('=')) index += 1;
    if (typeof credentials[secretName] !== 'string') {
      throw new Error(`Unable to transfer ${name} to the vis_bridge daemon.`);
    }
    requiredSecrets.push(secretName);
    secrets[secretName] = credentials[secretName];
  }
  return { launchArgs, requiredSecrets, secrets };
}

export function fingerprintDaemonCredentials(controlToken, credentials = {}) {
  return createHmac('sha256', controlToken)
    .update(
      JSON.stringify({
        bridgeToken: credentials.bridgeToken ?? null,
        upstreamAuthorization: credentials.upstreamAuthorization ?? null,
      }),
    )
    .digest('hex');
}
