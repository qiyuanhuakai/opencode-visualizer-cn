import { createServer } from 'node:http';
import { homedir } from 'node:os';
import {
  authorizeHttpRequest,
  rejectUnprotectedBridgeControlHttp,
  rejectUnprotectedBridgeControlUpgrade,
  rejectUnprotectedFsHttp,
  rejectUnprotectedPtyHttp,
  requiresFsToken,
  requiresPtyToken,
  writeCorsHeaders,
  writeJsonHttpResponse,
} from './bridgeHttp.js';
import {
  handleFsHttpRequest,
  handlePtyHttpRequest,
  handleSupervisorHttpRequest,
  jsonBodyErrorStatus,
  readJsonBody,
} from './bridgeHttpRoutes.js';
import { proxyWebSocket } from './codexWebSocketProxy.js';
import { createPtyManager } from './ptyManager.js';
import { handleAcpUpgrade, handlePtyUpgrade } from './bridgeWebSocketRoutes.js';
import { createWorkspaceCommandRunner } from './workspaceCommand.js';
import { createWorkspaceFsManager } from './workspaceFs.js';

const DEFAULT_HOST = '127.0.0.1';

export function createVisBridgeServer(options) {
  const bridgeOptions = { host: DEFAULT_HOST, ...options };
  const ptyManager = createPtyManager(bridgeOptions);
  const fsManager = createWorkspaceFsManager();
  const commandRunner = createWorkspaceCommandRunner();
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'OPTIONS') {
      writeCorsHeaders(response, 204);
      response.end();
      return;
    }

    if (requestUrl.pathname === '/homedir') {
      if (!authorizeHttpRequest(request, response, options.bridgeToken)) return;
      writeJsonHttpResponse(response, 200, { home: homedir() });
      return;
    }

    if (requestUrl.pathname === '/healthz' || requestUrl.pathname === '/readyz') {
      if (!authorizeHttpRequest(request, response, options.bridgeToken)) return;
      writeJsonHttpResponse(response, 200, { ok: true, service: 'vis_bridge' });
      return;
    }

    if (requestUrl.pathname === '/pty' || requestUrl.pathname.startsWith('/pty/')) {
      if (requiresPtyToken(bridgeOptions)) {
        rejectUnprotectedPtyHttp(response);
        return;
      }
      if (!authorizeHttpRequest(request, response, bridgeOptions.bridgeToken)) return;
      void handlePtyHttpRequest(request, response, requestUrl, ptyManager).then((handled) => {
        if (!handled) writeJsonHttpResponse(response, 404, { error: 'Not found' });
      });
      return;
    }

    if (
      requestUrl.pathname === '/fs/capabilities' ||
      requestUrl.pathname === '/fs/list' ||
      requestUrl.pathname === '/fs/readFile' ||
      requestUrl.pathname === '/fs/writeFile'
    ) {
      if (requiresFsToken(bridgeOptions)) {
        rejectUnprotectedFsHttp(response);
        return;
      }
      if (!authorizeHttpRequest(request, response, bridgeOptions.bridgeToken)) return;
      void handleFsHttpRequest(request, response, requestUrl, fsManager).then((handled) => {
        if (!handled) writeJsonHttpResponse(response, 404, { error: 'Not found' });
      });
      return;
    }

    if (requestUrl.pathname === '/command/exec') {
      if (requiresPtyToken(bridgeOptions)) {
        rejectUnprotectedBridgeControlHttp(response);
        return;
      }
      if (!authorizeHttpRequest(request, response, bridgeOptions.bridgeToken)) return;
      if (request.method !== 'POST') {
        writeJsonHttpResponse(response, 405, { error: 'Method not allowed' });
        return;
      }
      void readJsonBody(request)
        .then((payload) => commandRunner.run(payload))
        .then((result) => writeJsonHttpResponse(response, 200, result))
        .catch((error) =>
          writeJsonHttpResponse(response, jsonBodyErrorStatus(error, 400), {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return;
    }

    if (requestUrl.pathname.startsWith('/api/v1/')) {
      if (requiresPtyToken(bridgeOptions)) {
        rejectUnprotectedBridgeControlHttp(response);
        return;
      }
      if (!authorizeHttpRequest(request, response, bridgeOptions.bridgeToken)) return;
      if (!bridgeOptions.runtime) {
        writeJsonHttpResponse(response, 503, { error: 'Bridge supervisor is unavailable.' });
        return;
      }
      void handleSupervisorHttpRequest(
        request,
        response,
        requestUrl,
        bridgeOptions.runtime,
      )
        .then((handled) => {
          if (!handled) writeJsonHttpResponse(response, 404, { error: 'Not found' });
        })
        .catch((error) => {
          writeJsonHttpResponse(response, jsonBodyErrorStatus(error, 400), {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (!authorizeHttpRequest(request, response, options.bridgeToken)) return;
    writeJsonHttpResponse(response, 200, {
      service: 'vis_bridge',
      websocketPath: options.path,
      target: options.target,
      bridgeAuth: Boolean(options.bridgeToken),
      upstreamAuth: Boolean(options.upstreamAuthorization),
    });
  });

  server.on('upgrade', (request, socket, head) => {
    if (handlePtyUpgrade(request, socket, head, bridgeOptions, ptyManager)) return;
    if (handleAcpUpgrade(request, socket, head, bridgeOptions)) return;
    if (requiresPtyToken(bridgeOptions)) {
      rejectUnprotectedBridgeControlUpgrade(socket);
      return;
    }
    void proxyWebSocket(request, socket, head, bridgeOptions);
  });

  server.on('close', () => {
    ptyManager.disposeAll();
    void commandRunner.close();
    void bridgeOptions.runtime?.stop();
  });

  server.stopOwnedProcesses = () => commandRunner.close();

  return server;
}
