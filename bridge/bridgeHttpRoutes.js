import { loadAcpSessionTurnMeta } from './acpSessionMeta.js';
import { writeJsonHttpResponse } from './bridgeHttp.js';

export function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('error', reject);
    request.on('end', () => {
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
    });
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
    writeJsonHttpResponse(response, 500, {
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
    writeJsonHttpResponse(response, 500, {
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
