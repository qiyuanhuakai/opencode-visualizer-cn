type QueryValue = string | number | boolean | undefined;

type JsonBody = Record<string, unknown> | Array<unknown>;
type RequestOptions = {
  instanceDirectory?: string;
};

function buildQuery(params?: Record<string, QueryValue>) {
  if (!params) return '';
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined) return;
    searchParams.set(key, String(value));
  });
  const query = searchParams.toString();
  return query ? `?${query}` : '';
}

function createUrl(baseUrl: string, path: string, params?: Record<string, QueryValue>) {
  return `${baseUrl}${path}${buildQuery(params)}`;
}

async function parseJson(response: Response) {
  if (response.status === 204 || response.status === 205) return null;
  if (response.headers.get('content-length') === '0') return null;

  const raw = await response.text();
  if (!raw.trim()) return null;

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function buildHeaders(options?: RequestOptions, contentType?: string) {
  const headers: Record<string, string> = {};
  if (contentType) headers['Content-Type'] = contentType;
  if (options?.instanceDirectory) headers['x-opencode-directory'] = options.instanceDirectory;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

async function getJson(
  baseUrl: string,
  path: string,
  params?: Record<string, QueryValue>,
  options?: RequestOptions,
) {
  const response = await fetch(createUrl(baseUrl, path, params), {
    headers: buildHeaders(options),
  });
  if (!response.ok) throw new Error(`${path} request failed (${response.status})`);
  return parseJson(response);
}

async function sendJson(
  baseUrl: string,
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  options: { params?: Record<string, QueryValue>; body?: JsonBody; request?: RequestOptions },
) {
  const response = await fetch(createUrl(baseUrl, path, options.params), {
    method,
    headers: buildHeaders(options.request, 'application/json'),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) throw new Error(`${path} request failed (${response.status})`);
  return parseJson(response);
}

export function createWsUrl(baseUrl: string, path: string, params?: Record<string, QueryValue>) {
  const wsBase = baseUrl.replace(/^http/, 'ws');
  return createUrl(wsBase, path, params);
}

export function getPathInfo(baseUrl: string) {
  return getJson(baseUrl, '/path') as Promise<Record<string, string>>;
}

export function listFiles(baseUrl: string, payload: { directory: string; path?: string }) {
  return getJson(baseUrl, '/file', {
    directory: payload.directory,
    path: payload.path,
  }) as Promise<unknown>;
}

export function readFileContent(baseUrl: string, payload: { directory: string; path: string }) {
  return getJson(baseUrl, '/file/content', {
    directory: payload.directory,
    path: payload.path,
  }) as Promise<unknown>;
}

export function getSessionDiff(
  baseUrl: string,
  payload: { sessionID: string; directory?: string },
) {
  return getJson(baseUrl, `/session/${payload.sessionID}/diff`, {
    directory: payload.directory,
  }) as Promise<unknown>;
}

export function listProjects(baseUrl: string, directory?: string) {
  return getJson(baseUrl, '/project', { directory }) as Promise<unknown>;
}

export function getCurrentProject(baseUrl: string, directory?: string) {
  return getJson(baseUrl, '/project/current', { directory }) as Promise<unknown>;
}

export function listSessions(
  baseUrl: string,
  options: {
    directory?: string;
    roots?: boolean;
    search?: string;
    limit?: number;
    instanceDirectory?: string;
  } = {},
) {
  return getJson(baseUrl, '/session', {
    directory: options.directory,
    roots: options.roots ? 'true' : undefined,
    search: options.search,
    limit: options.limit,
  }, {
    instanceDirectory: options.instanceDirectory,
  }) as Promise<unknown>;
}

export function getSessionChildren(
  baseUrl: string,
  sessionId: string,
  directory?: string,
  request?: RequestOptions,
) {
  return getJson(baseUrl, `/session/${sessionId}/children`, {
    directory,
  }, request) as Promise<unknown>;
}

export function listWorktrees(baseUrl: string, directory: string) {
  return getJson(baseUrl, '/experimental/worktree', { directory }) as Promise<unknown>;
}

export function getVcsInfo(baseUrl: string, directory: string) {
  return getJson(baseUrl, '/vcs', { directory }) as Promise<unknown>;
}

export function createWorktree(baseUrl: string, directory: string) {
  return sendJson(baseUrl, '/experimental/worktree', 'POST', {
    params: { directory },
    body: {},
  }) as Promise<unknown>;
}

export function deleteWorktree(baseUrl: string, directory: string, targetDirectory: string) {
  return sendJson(baseUrl, '/experimental/worktree', 'DELETE', {
    params: { directory },
    body: { directory: targetDirectory },
  }) as Promise<unknown>;
}

export function createSession(baseUrl: string, directory?: string) {
  return sendJson(baseUrl, '/session', 'POST', {
    params: { directory },
    body: {},
  }) as Promise<unknown>;
}

export async function deleteSession(baseUrl: string, sessionId: string, directory?: string) {
  const response = await fetch(createUrl(baseUrl, `/session/${sessionId}`, { directory }), {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error(`/session/${sessionId} request failed (${response.status})`);
}

export function updateSession(
  baseUrl: string,
  sessionId: string,
  payload: { title?: string; time?: { archived?: number } },
  directory?: string,
) {
  return sendJson(baseUrl, `/session/${sessionId}`, 'PATCH', {
    params: { directory },
    body: payload,
  }) as Promise<unknown>;
}

export function forkSession(
  baseUrl: string,
  sessionId: string,
  messageId: string,
  directory?: string,
) {
  return sendJson(baseUrl, `/session/${sessionId}/fork`, 'POST', {
    params: { directory },
    body: { messageID: messageId },
  }) as Promise<unknown>;
}

export function revertSession(
  baseUrl: string,
  sessionId: string,
  messageId: string,
  directory?: string,
) {
  return sendJson(baseUrl, `/session/${sessionId}/revert`, 'POST', {
    params: { directory },
    body: { messageID: messageId },
  }) as Promise<unknown>;
}

export function listProviders(baseUrl: string) {
  return getJson(baseUrl, '/config/providers') as Promise<unknown>;
}

export function listAgents(baseUrl: string) {
  return getJson(baseUrl, '/agent') as Promise<unknown>;
}

export function listCommands(baseUrl: string, directory?: string) {
  return getJson(baseUrl, '/command', { directory }) as Promise<unknown>;
}

export function getSessionStatusMap(
  baseUrl: string,
  directory?: string,
  request?: RequestOptions,
) {
  return getJson(baseUrl, '/session/status', { directory }, request) as Promise<unknown>;
}

export function listPendingPermissions(baseUrl: string, directory?: string) {
  return getJson(baseUrl, '/permission', { directory }) as Promise<unknown>;
}

export function listPendingQuestions(baseUrl: string, directory?: string) {
  return getJson(baseUrl, '/question', { directory }) as Promise<unknown>;
}

export function listSessionMessages(
  baseUrl: string,
  sessionId: string,
  options: { directory?: string; limit?: number } = {},
) {
  return getJson(baseUrl, `/session/${sessionId}/message`, {
    directory: options.directory,
    limit: options.limit,
  }) as Promise<unknown>;
}

export function getSessionMessage(
  baseUrl: string,
  sessionId: string,
  messageId: string,
  directory?: string,
) {
  return getJson(baseUrl, `/session/${sessionId}/message/${messageId}`, {
    directory,
  }) as Promise<unknown>;
}

export function getSessionTodos(baseUrl: string, sessionId: string, directory?: string) {
  return getJson(baseUrl, `/session/${sessionId}/todo`, { directory }) as Promise<unknown>;
}

export function listPtys(baseUrl: string, directory?: string) {
  return getJson(baseUrl, '/pty', { directory }) as Promise<unknown>;
}

export function createPty(
  baseUrl: string,
  payload: { directory?: string; cwd?: string; command?: string; args?: string[]; title?: string },
) {
  return sendJson(baseUrl, '/pty', 'POST', {
    params: { directory: payload.directory },
    body: {
      command: payload.command,
      args: payload.args,
      cwd: payload.cwd,
      title: payload.title,
    },
  }) as Promise<unknown>;
}

export function updatePtySize(
  baseUrl: string,
  ptyId: string,
  payload: { directory?: string; rows: number; cols: number },
) {
  return sendJson(baseUrl, `/pty/${ptyId}`, 'PUT', {
    params: { directory: payload.directory },
    body: { size: { rows: payload.rows, cols: payload.cols } },
  }) as Promise<unknown>;
}

export async function sendCommand(
  baseUrl: string,
  sessionId: string,
  payload: {
    directory?: string;
    command: string;
    arguments: string;
    agent?: string;
    model?: string;
    variant?: string;
  },
) {
  await sendJson(baseUrl, `/session/${sessionId}/command`, 'POST', {
    params: { directory: payload.directory },
    body: payload,
  });
}

export async function sendPromptAsync(
  baseUrl: string,
  sessionId: string,
  payload: {
    directory: string;
    agent: string;
    model: { providerID?: string; modelID: string };
    variant?: string;
    parts: Array<Record<string, unknown>>;
  },
) {
  await sendJson(baseUrl, `/session/${sessionId}/prompt_async`, 'POST', {
    params: { directory: payload.directory },
    body: {
      agent: payload.agent,
      model: payload.model,
      variant: payload.variant,
      parts: payload.parts,
    },
  });
}

export async function abortSession(baseUrl: string, sessionId: string, directory?: string) {
  await sendJson(baseUrl, `/session/${sessionId}/abort`, 'POST', {
    params: { directory },
  });
}

export async function replyPermission(
  baseUrl: string,
  requestId: string,
  payload: { directory?: string; reply: string },
) {
  await sendJson(baseUrl, `/permission/${requestId}/reply`, 'POST', {
    params: { directory: payload.directory },
    body: { reply: payload.reply },
  });
}

export async function replyQuestion(
  baseUrl: string,
  requestId: string,
  payload: { directory?: string; answers: string[][] },
) {
  await sendJson(baseUrl, `/question/${requestId}/reply`, 'POST', {
    params: { directory: payload.directory },
    body: { answers: payload.answers },
  });
}

export async function rejectQuestion(baseUrl: string, requestId: string, directory?: string) {
  await sendJson(baseUrl, `/question/${requestId}/reject`, 'POST', {
    params: { directory },
  });
}
