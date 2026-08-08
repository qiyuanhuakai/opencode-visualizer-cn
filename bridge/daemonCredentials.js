import { createHmac } from 'node:crypto';

const SECRET_OPTIONS = new Map([
  ['--bridge-token', 'bridgeToken'],
  ['--upstream-token', 'upstreamAuthorization'],
]);

export function assertRequiredDaemonCredentials(requiredSecrets = [], credentials = {}) {
  if (requiredSecrets.some((name) => typeof credentials[name] !== 'string')) {
    throw new Error(
      'vis_bridge restart requires the original direct token options; use token files or environment variables for unattended restarts.',
    );
  }
}

export function prepareDaemonLaunch(serverArgs, credentials = {}) {
  const launchArgs = [];
  const secrets = {};
  const requiredSecrets = [];
  for (let index = 0; index < serverArgs.length; index += 1) {
    const argument = serverArgs[index];
    const [optionName] = argument.split('=', 1);
    const secretName = SECRET_OPTIONS.get(optionName);
    if (!secretName) {
      launchArgs.push(argument);
      continue;
    }
    if (!argument.includes('=')) index += 1;
    if (typeof credentials[secretName] !== 'string') {
      throw new Error(`Unable to transfer ${optionName} to the vis_bridge daemon.`);
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
