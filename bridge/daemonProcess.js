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

function trackConnections(server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return sockets;
}

function closeServer(server, sockets) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const forceClose = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
    }, 500);
    server.close((error) => {
      clearTimeout(forceClose);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });
}

function receiveStartOptions(instanceId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      process.off('message', onMessage);
      reject(new Error('vis_bridge daemon did not receive startup options.'));
    }, 5_000);
    const onMessage = (message) => {
      if (
        !message ||
        typeof message !== 'object' ||
        message.type !== 'start-options' ||
        message.instanceId !== instanceId ||
        !message.secrets ||
        typeof message.secrets !== 'object' ||
        !Array.isArray(message.requiredSecrets)
      ) {
        return;
      }
      clearTimeout(timeout);
      process.off('message', onMessage);
      resolve(message);
    };
    process.on('message', onMessage);
    process.send?.({ type: 'awaiting-options', instanceId });
  });
}

export async function runDaemonProcess(options, createBridgeServer) {
  const instanceId = process.env.VIS_BRIDGE_DAEMON_INSTANCE_ID;
  if (!instanceId) throw new Error('vis_bridge daemon identity is missing.');
  delete process.env.VIS_BRIDGE_DAEMON_INSTANCE_ID;
  delete process.env.VIS_BRIDGE_TOKEN;
  delete process.env.VIS_BRIDGE_CODEX_TOKEN;
  delete process.env.VIS_BRIDGE_CODEX_TOKEN_FILE;
  delete process.env.VIS_BRIDGE_CODEX_AUTHORIZATION;
  const startOptions = await receiveStartOptions(instanceId);
  const controlToken = startOptions.controlToken;
  if (typeof controlToken !== 'string' || !controlToken) {
    throw new Error('vis_bridge daemon control credentials are missing.');
  }
  options = { ...options, ...startOptions.secrets };
  const paths = createDaemonPaths();
  const configStore = createBridgeConfigStore({ configPath: options.configPath });
  const runtime = createBridgeRuntime({ configStore });
  const server = createBridgeServer({ ...options, runtime });
  const serverSockets = trackConnections(server);
  let controlServer;
  let controlSockets = new Set();
  let startupPromise;
  let shutdownPromise;

  await writeDaemonState(paths, {
    instanceId,
    pid: process.pid,
    state: 'starting',
    logPath: paths.logPath,
    launchArgs: [...options.serverArgs],
    credentialFingerprint: startOptions.credentialFingerprint,
    requiredSecrets: [...startOptions.requiredSecrets],
    startedAt: new Date().toISOString(),
  });

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await startupPromise?.catch(() => undefined);
      await server.stopOwnedProcesses?.();
      await closeServer(server, serverSockets);
      await runtime.stop();
      if (controlServer) await closeServer(controlServer, controlSockets);
      await removeDaemonState(paths, instanceId);
    })();
    return shutdownPromise;
  };

  const exitAfterShutdown = () => {
    void shutdown().then(() => process.exit(0));
  };
  process.once('SIGINT', exitAfterShutdown);
  process.once('SIGTERM', exitAfterShutdown);

  try {
    startupPromise = runtime.start();
    const status = await startupPromise;
    if (shutdownPromise) {
      await shutdownPromise;
      return;
    }
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
    controlSockets = trackConnections(controlServer);
    const controlPort = await listenServer(controlServer, 0, '127.0.0.1');
    const port = await listenServer(server, options.port, options.host);
    const failures = collectStartupFailures(status);
    await writeDaemonState(paths, {
      instanceId,
      pid: process.pid,
      state: 'running',
      logPath: paths.logPath,
      launchArgs: [...options.serverArgs],
      credentialFingerprint: startOptions.credentialFingerprint,
      requiredSecrets: [...startOptions.requiredSecrets],
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
  } catch (error) {
    if (shutdownPromise) {
      await shutdownPromise;
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    await writeDaemonState(paths, {
      instanceId,
      pid: process.pid,
      state: 'error',
      logPath: paths.logPath,
      launchArgs: [...options.serverArgs],
      credentialFingerprint: startOptions.credentialFingerprint,
      requiredSecrets: [...startOptions.requiredSecrets],
      startedAt: new Date().toISOString(),
      error: message,
    });
    if (controlServer?.listening) await closeServer(controlServer, controlSockets);
    if (server.listening) await closeServer(server, serverSockets);
    await runtime.stop();
    process.send?.({ type: 'error', error: message });
    throw error;
  }
}
