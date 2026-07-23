import type { BackendQueryValue, BackendRequestOptions } from '../types';
import { acpBridgeHttpUrl, normalizeAcpBridgeUrl } from './bridgeUrl';
import { toRecord } from './wire';
import type { AcpSessionTurnMeta } from './history';

type WorkspaceClientOptions = {
  bridgeUrl: string;
  bridgeToken?: string;
};

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

function absoluteWorkspacePath(directory: string, relativePath: string) {
  if (/^(?:\/|[A-Za-z]:[\\/])/u.test(relativePath)) return relativePath;
  return `${directory.replace(/[\\/]+$/u, '')}/${relativePath.replace(/^[\\/]+/u, '')}`;
}

function decodeBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseCommandResult(value: unknown): CommandResult {
  if (!value || typeof value !== 'object') throw new Error('Invalid bridge command response.');
  const record = value as Record<string, unknown>;
  if (
    typeof record.stdout !== 'string' ||
    typeof record.stderr !== 'string' ||
    typeof record.exitCode !== 'number'
  ) {
    throw new Error('Invalid bridge command response.');
  }
  return { stdout: record.stdout, stderr: record.stderr, exitCode: record.exitCode };
}

function workspaceWebSocketUrl(
  bridgeUrl: string,
  endpoint: string,
  token: string,
  params: Record<string, BackendQueryValue>,
) {
  const parsed = new URL(normalizeAcpBridgeUrl(bridgeUrl));
  const prefix = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/u, '');
  parsed.pathname = `${prefix}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) parsed.searchParams.set(key, String(value));
  }
  if (token) parsed.searchParams.set('token', token);
  return parsed.toString();
}

export class AcpWorkspaceClient {
  private readonly bridgeUrl: string;
  private readonly bridgeToken: string;

  constructor(options: WorkspaceClientOptions) {
    this.bridgeUrl = options.bridgeUrl;
    this.bridgeToken = options.bridgeToken?.trim() ?? '';
  }

  private async json(
    endpoint: `/${string}`,
    init: RequestInit = {},
    query?: Record<string, string>,
  ) {
    const url = new URL(acpBridgeHttpUrl(this.bridgeUrl, endpoint));
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    if (this.bridgeToken) url.searchParams.set('token', this.bridgeToken);
    const headers = new Headers(init.headers);
    if (this.bridgeToken) headers.set('Authorization', `Bearer ${this.bridgeToken}`);
    const response = await fetch(url, { ...init, headers });
    const value: unknown = await response.json();
    if (!response.ok) {
      const message =
        value &&
        typeof value === 'object' &&
        typeof (value as Record<string, unknown>).error === 'string'
          ? String((value as Record<string, unknown>).error)
          : `ACP bridge request failed (${response.status})`;
      throw new Error(message);
    }
    return value;
  }

  async getAcpSessionMeta(agentId: string, sessionId: string): Promise<AcpSessionTurnMeta[]> {
    try {
      const result = await this.json(
        `/api/v1/agents/${encodeURIComponent(agentId)}/session-meta/${encodeURIComponent(sessionId)}`,
      );
      if (!Array.isArray(result)) return [];
      return result.flatMap((value): AcpSessionTurnMeta[] => {
        const record = toRecord(value);
        if (!record || typeof record.userText !== 'string') return [];
        return [
          {
            userText: record.userText,
            ...(typeof record.userTime === 'number' ? { userTime: record.userTime } : {}),
            ...(typeof record.assistantTime === 'number' ? { assistantTime: record.assistantTime } : {}),
            ...(typeof record.model === 'string' ? { model: record.model } : {}),
            ...(typeof record.agent === 'string' ? { agent: record.agent } : {}),
          },
        ];
      });
    } catch {
      return [];
    }
  }

  listFiles(payload: { directory: string; path?: string }) {
    return this.json(
      '/fs/list',
      {},
      {
        root: payload.directory,
        path: payload.path ?? '.',
      },
    );
  }

  readFile(payload: { directory: string; path: string }, options?: BackendRequestOptions) {
    return this.json(
      '/fs/readFile',
      { signal: options?.signal },
      {
        root: payload.directory,
        path: absoluteWorkspacePath(payload.directory, payload.path),
      },
    );
  }

  writeFile(
    payload: { directory: string; path: string; content: string },
    options?: BackendRequestOptions,
  ) {
    return this.json('/fs/writeFile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        root: payload.directory,
        path: absoluteWorkspacePath(payload.directory, payload.path),
        content: payload.content,
      }),
      signal: options?.signal,
    });
  }

  listPtys() {
    return this.json('/pty');
  }

  createPty(payload: Record<string, unknown>, options?: BackendRequestOptions) {
    const { directory, ...rest } = payload;
    return this.json('/pty', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...rest,
        ...(rest.cwd === undefined && typeof directory === 'string' ? { cwd: directory } : {}),
      }),
      signal: options?.signal,
    });
  }

  resizePty(ptyId: string, rows: number, cols: number) {
    return this.json(`/pty/${encodeURIComponent(ptyId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size: { rows, cols } }),
    });
  }

  deletePty(ptyId: string) {
    return this.json(`/pty/${encodeURIComponent(ptyId)}`, { method: 'DELETE' });
  }

  async createManagedAgentTerminal(agentId: string, args: string[], title: string) {
    const agents = await this.json('/api/v1/agents');
    if (!Array.isArray(agents)) throw new Error('Bridge ACP agent list is invalid.');
    const agent = agents.find((value) => {
      const record = toRecord(value);
      return record?.id === agentId && typeof record.command === 'string';
    });
    const record = toRecord(agent);
    if (!record || typeof record.command !== 'string') {
      throw new Error(`Managed ACP agent not found: ${agentId}.`);
    }
    return this.createPty({ command: record.command, args, title });
  }

  createPtyWebSocketUrl(path: string, params: Record<string, BackendQueryValue> = {}) {
    return workspaceWebSocketUrl(this.bridgeUrl, path, this.bridgeToken, params);
  }

  async runCommand(payload: { directory?: string; command: string; args: string[] }) {
    const value = await this.json('/command/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return parseCommandResult(value);
  }

  async runOneShotCommand(payload: { directory?: string; command: string; args: string[] }) {
    const result = await this.runCommand(payload);
    if (result.exitCode !== 0) {
      const error = new Error(`ACP bridge command failed (${result.exitCode})`) as Error & {
        output?: string;
      };
      error.output = result.stdout || result.stderr;
      throw error;
    }
    return result.stdout;
  }

  async getVcsInfo(directory: string) {
    const git = async (args: string[]) => {
      const result = await this.runCommand({ directory, command: 'git', args });
      if (result.exitCode !== 0) throw new Error(result.stderr || `git exited ${result.exitCode}`);
      return result.stdout.trim();
    };
    let root: string;
    try {
      root = await git(['rev-parse', '--show-toplevel']);
    } catch {
      return { root: '', branch: '' };
    }
    const [commonDirectory, branch, sha] = await Promise.all([
      git(['rev-parse', '--git-common-dir']).catch(() => ''),
      git(['branch', '--show-current']).catch(() => ''),
      git(['rev-parse', '--short', 'HEAD']).catch(() => ''),
    ]);
    const normalizedCommon =
      commonDirectory === '.git' ? root : commonDirectory.replace(/[\\/]\.git$/u, '');
    return {
      root,
      branch,
      ...(normalizedCommon ? { commonRoot: normalizedCommon } : {}),
      ...(normalizedCommon && normalizedCommon !== root ? { worktreeRoot: root } : {}),
      ...(sha ? { sha } : {}),
    };
  }

  async readFileBytes(
    payload: { directory: string; path: string },
    options?: BackendRequestOptions,
  ) {
    const value = await this.readFile(payload, options);
    if (!value || typeof value !== 'object') throw new Error('Invalid bridge file response.');
    const dataBase64 = (value as Record<string, unknown>).dataBase64;
    if (typeof dataBase64 !== 'string') throw new Error('Bridge file response is missing data.');
    return decodeBase64(dataBase64);
  }
}
