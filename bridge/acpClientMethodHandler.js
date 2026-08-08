import { constants } from 'node:fs';
import os from 'node:os';
import { open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createAcpTerminalManager } from './acpTerminalManager.js';

function toRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function requestKey(agentId, id) {
  return `${agentId}:${String(id)}`;
}

function sessionKey(agentId, sessionId) {
  return `${agentId}:${sessionId}`;
}

function parseRoots(params) {
  if (typeof params.cwd !== 'string' || !path.isAbsolute(params.cwd)) return null;
  const additional = Array.isArray(params.additionalDirectories)
    ? params.additionalDirectories.filter(
        (item) => typeof item === 'string' && path.isAbsolute(item),
      )
    : [];
  return [params.cwd, ...additional];
}

function isWithin(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

// Well-known per-agent data directories (relative to the user's home).
// Agents can already read/write these paths directly as local processes; the
// reverse-FS sandbox would otherwise break agents that keep session artifacts
// (plans, transcripts) outside the workspace cwd.
const AGENT_DATA_DIR_DEFAULTS = {
  'kimi-code': ['.kimi-code'],
  'oh-my-pi': ['.omp'],
};

export function createAcpClientMethodHandler(options = {}) {
  const terminalManager = options.terminalManager ?? createAcpTerminalManager();
  const terminalOwners = new Map();
  const pendingSessions = new Map();
  const sessionRoots = new Map();
  const inactiveAgents = new Set();

  function observeClientMessage(message, context) {
    if (inactiveAgents.has(context.agentId)) return;
    const params = toRecord(message.params);
    if (!params) return;
    if (message.method === 'session/new' && 'id' in message) {
      const roots = parseRoots(params);
      if (roots) {
        pendingSessions.set(requestKey(context.agentId, message.id), {
          agentId: context.agentId,
          roots,
        });
      }
      return;
    }
    if (
      (message.method === 'session/load' || message.method === 'session/resume') &&
      typeof params.sessionId === 'string'
    ) {
      const roots = parseRoots(params);
      if (roots) {
        sessionRoots.set(sessionKey(context.agentId, params.sessionId), {
          agentId: context.agentId,
          roots,
        });
      }
    }
  }

  function observeAgentMessage(message, context) {
    if (inactiveAgents.has(context.agentId)) return;
    if (!('id' in message)) return;
    const key = requestKey(context.agentId, message.id);
    const pending = pendingSessions.get(key);
    if (!pending) return;
    pendingSessions.delete(key);
    const result = toRecord(message.result);
    if (typeof result?.sessionId === 'string') {
      sessionRoots.set(sessionKey(context.agentId, result.sessionId), pending);
    }
  }

  function requireParams(request) {
    const params = toRecord(request.params);
    if (!params || typeof params.sessionId !== 'string') {
      throw new Error(`ACP ${request.method} requires sessionId.`);
    }
    return params;
  }

  const homeDir = options.homeDir ?? os.homedir();
  function extraRoots(agentId) {
    const configured = options.agentDataDirs?.[agentId];
    if (Array.isArray(configured)) {
      return configured.filter((dir) => typeof dir === 'string' && path.isAbsolute(dir));
    }
    return (AGENT_DATA_DIR_DEFAULTS[agentId] ?? []).map((dir) => path.join(homeDir, dir));
  }

  async function resolveSessionPath(agentId, sessionId, requestedPath, forWrite = false) {
    if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath)) {
      throw new Error('ACP filesystem paths must be absolute.');
    }
    const session = sessionRoots.get(sessionKey(agentId, sessionId));
    if (!session) throw new Error(`ACP session roots are unknown: ${sessionId}`);
    const roots = [...session.roots, ...extraRoots(agentId)];
    const resolved = path.resolve(requestedPath);
    if (!roots.some((rootPath) => isWithin(path.resolve(rootPath), resolved))) {
      throw new Error(`Path is outside the ACP session roots: ${requestedPath}`);
    }
    let target;
    try {
      target = await realpath(requestedPath);
    } catch (error) {
      if (!forWrite || !error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
      target = await realpath(path.dirname(requestedPath));
    }
    for (const rootPath of roots) {
      const root = await realpath(rootPath).catch(() => null);
      if (root && isWithin(root, target)) return requestedPath;
    }
    throw new Error(`Path is outside the ACP session roots: ${requestedPath}`);
  }

  function isWithinAgentDataDir(agentId, sessionId, requestedPath) {
    if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath)) return false;
    if (!sessionRoots.has(sessionKey(agentId, sessionId))) return false;
    const resolved = path.resolve(requestedPath);
    return extraRoots(agentId).some((dir) => isWithin(path.resolve(dir), resolved));
  }
  async function handler(request, context) {
    if (inactiveAgents.has(context.agentId)) {
      throw new Error(`ACP agent is not active: ${context.agentId}`);
    }
    const params = requireParams(request);
    if (request.method === 'fs/read_text_file') {
      try {
        const filePath = await resolveSessionPath(context.agentId, params.sessionId, params.path);
        const content = await readFile(filePath, 'utf8');
        const line = typeof params.line === 'number' ? Math.max(1, Math.trunc(params.line)) : 1;
        const limit =
          typeof params.limit === 'number' ? Math.max(0, Math.trunc(params.limit)) : undefined;
        const lines = content.split(/\r?\n/u);
        return {
          content: lines
            .slice(line - 1, limit === undefined ? undefined : line - 1 + limit)
            .join('\n'),
        };
      } catch (error) {
        // Agents store transient artifacts (plans, scratch state) in their own
        // data directories; those can legitimately vanish between turns. A
        // missing workspace file stays an error, but a missing agent-data file
        // degrades to empty content so session/load replay is not aborted.
        if (
          error && typeof error === 'object' && error.code === 'ENOENT' &&
          isWithinAgentDataDir(context.agentId, params.sessionId, params.path)
        ) {
          return { content: '' };
        }
        throw error;
      }
    }
    if (request.method === 'fs/write_text_file') {
      if (typeof params.content !== 'string')
        throw new Error('ACP fs/write_text_file requires content.');
      const filePath = await resolveSessionPath(
        context.agentId,
        params.sessionId,
        params.path,
        true,
      );
      const file = await open(
        filePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o666,
      );
      try {
        await file.writeFile(params.content, 'utf8');
      } finally {
        await file.close();
      }
      return {};
    }
    if (request.method === 'terminal/create') {
      const session = sessionRoots.get(sessionKey(context.agentId, params.sessionId));
      if (!session) throw new Error(`ACP session roots are unknown: ${params.sessionId}`);
      const cwd =
        typeof params.cwd === 'string'
          ? await resolveSessionPath(context.agentId, params.sessionId, params.cwd)
          : session.roots[0];
      const created = await terminalManager.create({ ...params, cwd });
      if (inactiveAgents.has(context.agentId)) {
        await terminalManager.release(created.terminalId);
        throw new Error(`ACP agent is not active: ${context.agentId}`);
      }
      terminalOwners.set(created.terminalId, {
        agentId: context.agentId,
        sessionId: params.sessionId,
      });
      return created;
    }
    if (typeof params.terminalId !== 'string')
      throw new Error(`ACP ${request.method} requires terminalId.`);
    const terminalOwner = terminalOwners.get(params.terminalId);
    if (
      terminalOwner &&
      (terminalOwner.agentId !== context.agentId || terminalOwner.sessionId !== params.sessionId)
    ) {
      throw new Error(`ACP terminal ${params.terminalId} does not belong to this ACP session.`);
    }
    if (request.method === 'terminal/output') return terminalManager.output(params.terminalId);
    if (request.method === 'terminal/wait_for_exit')
      return terminalManager.waitForExit(params.terminalId);
    if (request.method === 'terminal/kill') return terminalManager.kill(params.terminalId);
    if (request.method === 'terminal/release') {
      const result = await terminalManager.release(params.terminalId);
      terminalOwners.delete(params.terminalId);
      return result;
    }
    throw new Error(`Unsupported ACP client method: ${request.method}`);
  }

  handler.observeClientMessage = observeClientMessage;
  handler.observeAgentMessage = observeAgentMessage;
  handler.stopAll = async () => {
    await terminalManager.stopAll();
    terminalOwners.clear();
    pendingSessions.clear();
    sessionRoots.clear();
  };
  handler.releaseAgent = async (agentId) => {
    inactiveAgents.add(agentId);
    const ownedTerminalIds = [...terminalOwners.entries()]
      .filter(([, owner]) => owner.agentId === agentId)
      .map(([terminalId]) => terminalId);
    await Promise.allSettled(
      ownedTerminalIds.map((terminalId) => terminalManager.release(terminalId)),
    );
    for (const terminalId of ownedTerminalIds) terminalOwners.delete(terminalId);
    for (const [requestId, pending] of pendingSessions.entries()) {
      if (pending.agentId === agentId) pendingSessions.delete(requestId);
    }
    for (const [sessionId, session] of sessionRoots.entries()) {
      if (session.agentId === agentId) sessionRoots.delete(sessionId);
    }
  };
  handler.resumeAgent = (agentId) => {
    inactiveAgents.delete(agentId);
  };
  return handler;
}
