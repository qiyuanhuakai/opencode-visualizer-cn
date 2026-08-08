import { spawn } from 'node:child_process';
import {
  BRIDGE_CLIENT_METHODS,
  createAcpProcessStatus,
  formatAcpProcessError,
  sameAcpLaunch,
} from './acpProcessState.js';
import { createAcpProcessEntry, stopAcpChild, waitForStableAcpStartup } from './acpProcessLifecycle.js';
import { detachedProcessOptions } from './processTree.js';

export function createAcpProcessManager(options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const handleClientRequest = options.handleClientRequest;
  const entries = new Map();
  const statuses = new Map();
  let configuredAgents = [];

  function getStatus() {
    return configuredAgents.map((agent) => ({ ...statuses.get(agent.id), args: [...agent.args] }));
  }

  function detach(entry, closeClient = false) {
    if (!entry.client) return;
    entry.client.off('message', entry.onMessage);
    entry.client.off('close', entry.onClose);
    if (closeClient) entry.client.close(1001, 'ACP process stopped.');
    entry.client = undefined;
    entry.onMessage = undefined;
    entry.onClose = undefined;
    entry.status.connected = false;
  }

  async function handleStdoutMessage(entry, message, line) {
    handleClientRequest?.observeAgentMessage?.(message, { agentId: entry.agent.id });
    if (typeof message.method !== 'string' && message.id !== undefined && message.id !== null) {
      const pending = entry.pendingAgentResponses.get(message.id);
      if (pending) {
        entry.pendingAgentResponses.delete(message.id);
        if (pending.method === 'initialize' && message.result !== undefined) {
          entry.initializeResult = message.result;
        }
        if (entry.client && pending.generation === entry.clientGeneration) {
          entry.client.send(JSON.stringify({ ...message, id: pending.originalId }));
        }
        return;
      }
    }
    if (
      !handleClientRequest ||
      typeof message.method !== 'string' ||
      !('id' in message) ||
      !BRIDGE_CLIENT_METHODS.has(message.method)
    ) {
      entry.client?.send(line);
      return;
    }
    try {
      const result = await handleClientRequest(message, { agentId: entry.agent.id });
      entry.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
    } catch (error) {
      entry.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        })}\n`,
      );
    }
  }

  function forwardStdout(entry, chunk) {
    entry.stdoutBuffer += String(chunk);
    while (true) {
      const newline = entry.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = entry.stdoutBuffer.slice(0, newline).replace(/\r$/u, '');
      entry.stdoutBuffer = entry.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        entry.status.droppedFrames += 1;
        continue;
      }
      entry.stdoutQueue = entry.stdoutQueue
        .then(() => handleStdoutMessage(entry, message, line))
        .catch(() => {
          entry.status.droppedFrames += 1;
        });
    }
  }

  async function startAgent(agent) {
    const status = statuses.get(agent.id) ?? createAcpProcessStatus(agent);
    statuses.set(agent.id, status);
    status.state = 'starting';
    status.enabled = true;
    status.owned = false;
    status.connected = false;
    delete status.error;

    let child;
    try {
      child = spawnProcess(agent.command, agent.args, {
        env: { ...process.env, ...agent.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...detachedProcessOptions(),
      });
    } catch (error) {
      status.state = 'error';
      status.error = error instanceof Error ? error.message : String(error);
      return;
    }

    const entry = createAcpProcessEntry(agent, child, status);
    entries.set(agent.id, entry);
    child.stdout.on('data', (chunk) => forwardStdout(entry, chunk));
    child.stderr.on('data', (chunk) => {
      entry.stderr = `${entry.stderr}${String(chunk)}`.slice(-8_192);
    });
    child.once('exit', (code, signal) => {
      if (entries.get(agent.id) !== entry) return;
      entries.delete(agent.id);
      detach(entry, true);
      status.owned = false;
      delete status.pid;
      if (status.state === 'stopping') {
        status.state = status.enabled ? 'stopped' : 'disabled';
        delete status.error;
      } else if (status.state !== 'error') {
        status.state = 'error';
        status.error =
          formatAcpProcessError(agent, entry.stderr) ||
          `${agent.name} exited (${signal ?? code ?? 'unknown'}).`;
      }
    });

    const launched = await new Promise((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', (error) => {
        if (entries.get(agent.id) !== entry) return;
        entries.delete(agent.id);
        status.state = 'error';
        status.owned = false;
        delete status.pid;
        status.error = error.message;
        resolve(false);
      });
    });
    if (!launched) return;
    status.owned = true;
    status.pid = child.pid;
    await waitForStableAcpStartup(child, () => status.state === 'error');
    if (status.state === 'error' || entries.get(agent.id) !== entry) return;
    status.state = 'running';
  }

  async function stopEntry(entry, nextState = 'stopped') {
    await options.handleClientRequest?.releaseAgent?.(entry.agent.id);
    entry.status.state = 'stopping';
    detach(entry, true);
    await stopAcpChild(entry.child);
    if (entries.get(entry.agent.id) !== entry) return;
    entries.delete(entry.agent.id);
    entry.status.state = nextState;
    entry.status.owned = false;
    entry.status.connected = false;
    delete entry.status.pid;
  }

  async function reconcile(agents) {
    const nextById = new Map(agents.map((agent) => [agent.id, agent]));
    for (const [id, entry] of entries) {
      const next = nextById.get(id);
      if (!next || !next.enabled || !sameAcpLaunch(entry.agent, next)) {
        entry.status.enabled = Boolean(next?.enabled);
        await stopEntry(entry, next?.enabled ? 'stopped' : 'disabled');
      }
    }

    configuredAgents = agents.map((agent) => ({
      ...agent,
      args: [...agent.args],
      env: agent.env ? { ...agent.env } : undefined,
    }));
    for (const agent of configuredAgents) {
      let status = statuses.get(agent.id);
      if (!status) {
        status = createAcpProcessStatus(agent);
        statuses.set(agent.id, status);
      }
      Object.assign(status, {
        name: agent.name,
        command: agent.command,
        args: [...agent.args],
        enabled: agent.enabled,
      });
      if (!agent.enabled) {
        status.state = 'disabled';
        status.owned = false;
        status.connected = false;
        delete status.pid;
        delete status.error;
      } else if (!entries.has(agent.id)) {
        await startAgent(agent);
      }
    }
    return getStatus();
  }

  function attach(id, client) {
    const entry = entries.get(id);
    if (!entry || entry.status.state !== 'running')
      throw new Error(`ACP agent is not running: ${id}.`);
    if (entry.client) throw new Error(`ACP agent ${id} already has a connected client.`);
    const onMessage = (message) => {
      const text = String(message);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        client.close(1003, 'Invalid JSON-RPC payload.');
        return;
      }
      if (typeof parsed.method === 'string' && parsed.id !== undefined && parsed.id !== null) {
        if (parsed.method === 'initialize' && entry.initializeResult !== undefined) {
          client.send(
            JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: entry.initializeResult }),
          );
          return;
        }
        const internalId = entry.nextAgentRequestId;
        entry.nextAgentRequestId += 1;
        entry.pendingAgentResponses.set(internalId, {
          generation: entry.clientGeneration,
          originalId: parsed.id,
          method: parsed.method,
        });
        const outbound = { ...parsed, id: internalId };
        handleClientRequest?.observeClientMessage?.(outbound, { agentId: entry.agent.id });
        entry.child.stdin.write(`${JSON.stringify(outbound)}\n`);
        return;
      }
      handleClientRequest?.observeClientMessage?.(parsed, { agentId: entry.agent.id });
      entry.child.stdin.write(`${text}\n`);
    };
    const onClose = () => detach(entry);
    entry.client = client;
    entry.clientGeneration += 1;
    entry.onMessage = onMessage;
    entry.onClose = onClose;
    entry.status.connected = true;
    client.on('message', onMessage);
    client.on('close', onClose);
  }

  async function stopAll() {
    await Promise.all([...entries.values()].map((entry) => stopEntry(entry)));
  }

  return { reconcile, attach, getStatus, stopAll };
}
