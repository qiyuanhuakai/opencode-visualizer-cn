import { loadAcpSessionTurnMeta } from './acpSessionMeta.js';
import { writeJsonHttpResponse } from './bridgeHttp.js';
import { ProtocolError } from '../shared/runtime/capabilities.js';
import { assertNoSecretPayload } from '../shared/runtime/connectionProfile.js';

const JSON_BODY_LIMIT = 2 * 1024 * 1024;

export class JsonBodyTooLargeError extends Error {
  constructor(limit) {
    super(`JSON request body exceeded ${limit} bytes.`);
    this.name = 'JsonBodyTooLargeError';
  }
}

export function jsonBodyErrorStatus(error, fallbackStatus) {
  if (error instanceof JsonBodyTooLargeError) return 413;
  return error instanceof SyntaxError ? 400 : fallbackStatus;
}

export function readJsonBody(request, limit = JSON_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      request.off('data', onData);
      request.off('error', onError);
      request.off('end', onEnd);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      request.pause?.();
      reject(error);
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        fail(new JsonBodyTooLargeError(limit));
        return;
      }
      chunks.push(buffer);
    };
    const onError = (error) => fail(error);
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    };
    request.on('data', onData);
    request.on('error', onError);
    request.on('end', onEnd);
  });
}

export async function handlePtyHttpRequest(request, response, requestUrl, manager) {
  try {
    if (requestUrl.pathname === '/pty' && request.method === 'GET') {
      writeJsonHttpResponse(response, 200, manager.list());
      return true;
    }
    if (requestUrl.pathname === '/pty' && request.method === 'POST') {
      const payload = await readJsonBody(request);
      const result = await manager.create(payload);
      writeJsonHttpResponse(response, 200, result);
      return true;
    }
    const match = requestUrl.pathname.match(/^\/pty\/([^/]+)$/u);
    if (!match) return false;
    const id = decodeURIComponent(match[1]);
    if (request.method === 'PUT') {
      const payload = await readJsonBody(request);
      const ok = manager.resize(
        id,
        payload?.size?.rows ?? payload?.rows,
        payload?.size?.cols ?? payload?.cols,
      );
      writeJsonHttpResponse(response, ok ? 200 : 404, ok ? {} : { error: 'PTY not found.' });
      return true;
    }
    if (request.method === 'DELETE') {
      const ok = manager.remove(id);
      writeJsonHttpResponse(response, ok ? 200 : 404, ok ? {} : { error: 'PTY not found.' });
      return true;
    }
    return false;
  } catch (error) {
    writeJsonHttpResponse(response, jsonBodyErrorStatus(error, 500), {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

export async function handleFsHttpRequest(request, response, requestUrl, manager) {
  try {
    if (requestUrl.pathname === '/fs/capabilities' && request.method === 'GET') {
      const result = await manager.getCapabilities(requestUrl.searchParams.get('root'));
      writeJsonHttpResponse(response, 200, result);
      return true;
    }
    if (requestUrl.pathname === '/fs/list' && request.method === 'GET') {
      const result = await manager.listDirectory(
        requestUrl.searchParams.get('path'),
        requestUrl.searchParams.get('root'),
      );
      writeJsonHttpResponse(response, 200, result);
      return true;
    }
    if (requestUrl.pathname === '/fs/readFile' && request.method === 'GET') {
      const result = await manager.readFile(
        requestUrl.searchParams.get('path'),
        requestUrl.searchParams.get('root'),
      );
      writeJsonHttpResponse(response, 200, result);
      return true;
    }
    if (requestUrl.pathname === '/fs/writeFile' && request.method === 'POST') {
      const payload = await readJsonBody(request);
      const result = await manager.writeFile(payload?.path, payload?.root, payload?.content);
      writeJsonHttpResponse(response, 200, result);
      return true;
    }
    return false;
  } catch (error) {
    writeJsonHttpResponse(response, jsonBodyErrorStatus(error, 500), {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

export async function handleSupervisorHttpRequest(request, response, requestUrl, runtime) {
  if (requestUrl.pathname === '/api/v1/supervisor' && request.method === 'GET') {
    writeJsonHttpResponse(response, 200, runtime.getStatus());
    return true;
  }
  if (requestUrl.pathname === '/api/v1/agents' && request.method === 'GET') {
    writeJsonHttpResponse(response, 200, await runtime.listAgents());
    return true;
  }
  if (requestUrl.pathname === '/api/v1/agents' && request.method === 'POST') {
    const agent = await runtime.upsertAgent(await readJsonBody(request));
    writeJsonHttpResponse(response, 201, agent);
    return true;
  }
  const sessionMetaMatch = requestUrl.pathname.match(
    /^\/api\/v1\/agents\/([^/]+)\/session-meta\/([^/]+)$/u,
  );
  if (sessionMetaMatch && request.method === 'GET') {
    const meta = await loadAcpSessionTurnMeta(
      decodeURIComponent(sessionMetaMatch[1]),
      decodeURIComponent(sessionMetaMatch[2]),
    );
    writeJsonHttpResponse(response, meta ? 200 : 404, meta ?? { error: 'ACP session meta unavailable.' });
    return true;
  }
  const match = requestUrl.pathname.match(/^\/api\/v1\/agents\/([^/]+)$/u);
  if (!match) return false;
  const id = decodeURIComponent(match[1]);
  if (request.method === 'PUT') {
    const agent = await runtime.updateAgent(id, await readJsonBody(request));
    writeJsonHttpResponse(response, agent ? 200 : 404, agent ?? { error: 'ACP agent not found.' });
    return true;
  }
  if (request.method === 'DELETE') {
    const removed = await runtime.removeAgent(id);
    writeJsonHttpResponse(
      response,
      removed ? 200 : 404,
      removed ? { removed: true } : { error: 'ACP agent not found.' },
    );
    return true;
  }
  return false;
}

const PROFILE_ACTION = /^\/api\/v1\/profiles\/([^/]+)\/(connect|disconnect|reconnect|enabled)$/u;
const PROFILE_ITEM = /^\/api\/v1\/profiles\/([^/]+)$/u;
const PROFILE_ERROR_STATUS = Object.freeze({
  invalid_request: 400,
  unsupported: 400,
  version_mismatch: 400,
  unauthorized: 401,
  conflict: 409,
  cancelled: 409,
  source_unavailable: 404,
  timeout: 504,
});

export function profileErrorStatus(error) {
  const code = error instanceof ProtocolError ? error.code : undefined;
  return PROFILE_ERROR_STATUS[code] ?? 500;
}

/** Profile management API: one surface for Browser and Electron; every response runs the secret guard. */
export async function handleProfileHttpRequest(request, response, requestUrl, manager) {
  const { pathname } = requestUrl;
  if (!pathname.startsWith('/api/v1/profiles')) return false;
  const method = request.method ?? 'GET';
  const send = (status, body) => {
    assertNoSecretPayload(body);
    writeJsonHttpResponse(response, status, body);
  };
  try {
    if (pathname === '/api/v1/profiles') {
      if (method === 'GET') {
        send(200, { profiles: await manager.list() });
        return true;
      }
      if (method === 'POST') {
        send(201, await manager.create(await readJsonBody(request)));
        return true;
      }
      send(405, { error: 'Method not allowed.' });
      return true;
    }
    const action = pathname.match(PROFILE_ACTION);
    if (action) {
      const id = decodeURIComponent(action[1]);
      const verb = action[2];
      if (verb === 'enabled' && method === 'PUT') {
        const payload = await readJsonBody(request);
        const enabled = await manager.setEnabled(id, payload?.enabled);
        send(enabled ? 200 : 404, enabled ?? { error: 'Profile not found.' });
        return true;
      }
      if (verb === 'connect' && method === 'POST') {
        send(200, await manager.connect(id));
        return true;
      }
      if (verb === 'disconnect' && method === 'POST') {
        send(200, await manager.disconnect(id));
        return true;
      }
      if (verb === 'reconnect' && method === 'POST') {
        send(200, await manager.reconnect(id));
        return true;
      }
      send(405, { error: 'Method not allowed.' });
      return true;
    }
    const item = pathname.match(PROFILE_ITEM);
    if (!item) return false;
    const id = decodeURIComponent(item[1]);
    if (method === 'GET') {
      const profile = await manager.get(id);
      send(profile ? 200 : 404, profile ?? { error: 'Profile not found.' });
      return true;
    }
    if (method === 'PATCH' || method === 'PUT') {
      const updated = await manager.update(id, await readJsonBody(request));
      send(updated ? 200 : 404, updated ?? { error: 'Profile not found.' });
      return true;
    }
    if (method === 'DELETE') {
      send(200, await manager.delete(id));
      return true;
    }
    send(405, { error: 'Method not allowed.' });
    return true;
  } catch (error) {
    send(profileErrorStatus(error), {
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof ProtocolError ? error.code : undefined,
    });
    return true;
  }
}
