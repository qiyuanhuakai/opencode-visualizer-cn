import { createServer } from 'node:http';
import { createBridgeConfigStore } from './bridgeConfig.js';
import { createBridgeRuntime } from './bridgeRuntime.js';
import { collectStartupFailures } from './daemonController.js';
import { createDaemonPaths, removeDaemonState, writeDaemonState } from './daemonState.js';

function listenServer(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('vis_bridge did not receive a TCP listen address.'));
        return;
      }
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function runDaemonProcess(options, createBridgeServer) {
  const instanceId = process.env.VIS_BRIDGE_DAEMON_INSTANCE_ID;
  const controlToken = process.env.VIS_BRIDGE_DAEMON_CONTROL_TOKEN;
  if (!instanceId || !controlToken) throw new Error('vis_bridge daemon credentials are missing.');
  const paths = createDaemonPaths();
  const configStore = createBridgeConfigStore({ configPath: options.configPath });
  const runtime = createBridgeRuntime({ configStore });
  const server = createBridgeServer({ ...options, runtime });
  let controlServer;
  let shutdownPromise;

  await writeDaemonState(paths, {
    instanceId,
    pid: process.pid,
    state: 'starting',
    logPath: paths.logPath,
    launchArgs: [...options.serverArgs],
    startedAt: new Date().toISOString(),
  });

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await closeServer(server);
      await runtime.stop();
      if (controlServer) await closeServer(controlServer);
      await removeDaemonState(paths, instanceId);
    })();
    return shutdownPromise;
  };

  try {
    const status = await runtime.start();
    controlServer = createServer((request, response) => {
      const authorized =
        request.headers.authorization === `Bearer ${controlToken}` &&
        request.headers['x-vis-bridge-instance'] === instanceId;
      if (!authorized) {
        response.writeHead(403).end();
        return;
      }
      if (request.method === 'GET' && request.url === '/status') {
        response.writeHead(200).end();
        return;
      }
      if (request.method !== 'POST' || request.url !== '/stop') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(202).end();
      setImmediate(() => {
        void shutdown().then(() => process.exit(0));
      });
    });
    const controlPort = await listenServer(controlServer, 0, '127.0.0.1');
    const port = await listenServer(server, options.port, options.host);
    const failures = collectStartupFailures(status);
    await writeDaemonState(paths, {
      instanceId,
      pid: process.pid,
      state: 'running',
      logPath: paths.logPath,
      launchArgs: [...options.serverArgs],
      startedAt: new Date().toISOString(),
      host: options.host,
      port,
      path: options.path,
      controlPort,
      controlToken,
      failures,
    });
    process.send?.({ type: 'ready', host: options.host, port, path: options.path, failures });
    process.disconnect?.();
    console.log(`vis_bridge listening on ws://${options.host}:${port}${options.path}`);
    console.log(`vis_bridge proxy target: ${options.target}`);
    process.once('SIGINT', () => {
      void shutdown().then(() => process.exit(0));
    });
    process.once('SIGTERM', () => {
      void shutdown().then(() => process.exit(0));
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeDaemonState(paths, {
      instanceId,
      pid: process.pid,
      state: 'error',
      logPath: paths.logPath,
      launchArgs: [...options.serverArgs],
      startedAt: new Date().toISOString(),
      error: message,
    });
    process.send?.({ type: 'error', error: message });
    if (controlServer?.listening) await closeServer(controlServer);
    if (server.listening) await closeServer(server);
    await runtime.stop();
    throw error;
  }
}
