import { BRIDGE_CLIENT_METHODS } from './acpProcessState.js';

const MAX_STDOUT_FRAME_CHARS = 2 * 1024 * 1024;

export function createAcpStdoutForwarder(options) {
  const { entries, handleClientRequest } = options;

  async function handleMessage(entry, message, line) {
    if (entries.get(entry.agent.id) !== entry || entry.status.state === 'stopping') return;
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
      if (entries.get(entry.agent.id) !== entry || entry.status.state === 'stopping') return;
      entry.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
    } catch (error) {
      if (entries.get(entry.agent.id) !== entry || entry.status.state === 'stopping') return;
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

  return function forwardStdout(entry, chunk) {
    let text = String(chunk);
    if (entry.discardingOversizedFrame) {
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      text = text.slice(newline + 1);
      entry.discardingOversizedFrame = false;
    }
    entry.stdoutBuffer += text;
    while (true) {
      const newline = entry.stdoutBuffer.indexOf('\n');
      if (newline < 0) {
        if (entry.stdoutBuffer.length > MAX_STDOUT_FRAME_CHARS) {
          entry.stdoutBuffer = '';
          entry.discardingOversizedFrame = true;
          entry.status.droppedFrames += 1;
        }
        return;
      }
      const line = entry.stdoutBuffer.slice(0, newline).replace(/\r$/u, '');
      entry.stdoutBuffer = entry.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      if (line.length > MAX_STDOUT_FRAME_CHARS) {
        entry.status.droppedFrames += 1;
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        entry.status.droppedFrames += 1;
        continue;
      }
      entry.stdoutQueue = entry.stdoutQueue
        .then(() => handleMessage(entry, message, line))
        .catch(() => {
          entry.status.droppedFrames += 1;
        });
    }
  };
}
