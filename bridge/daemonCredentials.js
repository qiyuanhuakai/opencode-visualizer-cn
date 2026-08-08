const SECRET_OPTIONS = new Map([
  ['--bridge-token', 'bridgeToken'],
  ['--upstream-token', 'upstreamAuthorization'],
]);

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
