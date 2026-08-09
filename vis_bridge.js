#!/usr/bin/env node
import { parseCliOptions, usage } from './bridge/visBridgeCli.js';
import { createVisBridgeServer } from './bridge/visBridgeServer.js';
import { createDaemonController } from './bridge/daemonController.js';
import { runDaemonProcess } from './bridge/daemonProcess.js';

export { createVisBridgeServer, parseCliOptions };

export async function main() {
  const options = parseCliOptions();
  if (options.help || !options.command) {
    console.log(usage());
    return;
  }
  if (options.command === '__daemon') {
    await runDaemonProcess(options, createVisBridgeServer);
    return;
  }
  const controller = createDaemonController();
  const credentials = {
    bridgeToken: options.bridgeToken,
    upstreamAuthorization: options.upstreamTokenFile
      ? undefined
      : options.upstreamAuthorization,
  };
  const daemonArgs =
    options.command === 'restart' && !options.hasDaemonConfiguration
      ? options.daemonSecretArgs
      : options.daemonArgs;
  if (options.command === 'start') await controller.start(daemonArgs, credentials);
  else if (options.command === 'stop') await controller.stop();
  else await controller.restart(daemonArgs, credentials);
}

if (process.argv[1]?.endsWith('vis_bridge.js')) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
