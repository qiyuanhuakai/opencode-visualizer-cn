import { homedir } from 'node:os';
import path from 'node:path';
import { createAcpClientMethodHandler } from '../acpClientMethodHandler.js';
import { createAcpTerminalManager } from '../acpTerminalManager.js';
import { parseHarnessInstanceId } from '../../shared/runtime/identity.js';
import { requireValue, integerValue, textValue } from '../../shared/runtime/capabilities.js';

// Each driver process receives its own handler. Browser subscriptions cannot
// select a native agent/session owner or route reverse requests through a gateway.
export function createWorkspaceReverseTools() {
  const handlers = new Set();
  return {
    connect(scope) {
      return {
        register({ workspaceKey, harnessInstanceId, processGeneration, agentId, assertProcessCurrent, homeDir = homedir() }) {
          const grant = scope.authorize(workspaceKey, 'reverse');
          parseHarnessInstanceId(harnessInstanceId);
          integerValue(processGeneration, 'processGeneration'); textValue(agentId, 'agentId');
          requireValue(typeof assertProcessCurrent === 'function', 'process.assertCurrent');
          const context = { agentId: JSON.stringify([scope.binding.target, harnessInstanceId, processGeneration]) };
          const extras = { 'kimi-code': ['.kimi-code'], 'oh-my-pi': ['.omp'] };
          const terminals = createAcpTerminalManager();
          const handler = createAcpClientMethodHandler({ homeDir, agentDataDirs: { [context.agentId]: (extras[agentId] ?? []).map(dir => path.join(homeDir, dir)) }, terminalManager: {
            ...terminals,
            create: params => terminals.create({ ...params, outputByteLimit: Math.min(params.outputByteLimit ?? 2 * 1024 * 1024, 2 * 1024 * 1024) }),
          } });
          let active = true;
          const sessions = new Set();
          const pending = new Set();
          function assertOwner() {
            scope.authorizeRuntime(workspaceKey, 'reverse');
            requireValue(active, 'reverse.closed', 'source_unavailable');
            assertProcessCurrent();
          }
          const owner = {
            observeClientMessage(message) {
              assertOwner();
              if (['session/new', 'session/load', 'session/resume'].includes(message.method)) {
                requireValue(message.params?.cwd === grant.root && (!message.params.additionalDirectories || message.params.additionalDirectories.length === 0), 'reverse.workspace', 'unauthorized');
                if (message.method === 'session/new') pending.add(message.id);
                else { textValue(message.params.sessionId, 'sessionId'); sessions.add(message.params.sessionId); }
              }
              handler.observeClientMessage(message, context);
            },
            observeAgentMessage(message) {
              assertOwner();
              if (pending.delete(message.id) && typeof message.result?.sessionId === 'string') sessions.add(message.result.sessionId);
              handler.observeAgentMessage(message, context);
            },
            handle(request) {
              assertOwner();
              requireValue(sessions.has(request.params?.sessionId), 'reverse.session', 'unauthorized');
              const permission = request.method === 'fs/read_text_file' ? 'read' : request.method === 'fs/write_text_file' ? 'write' : 'command';
              scope.authorizeRuntime(workspaceKey, permission);
              return handler(request, context);
            },
            async close() { active = false; await handler.stopAll(); handlers.delete(owner); },
          };
          handlers.add(owner);
          return owner;
        },
      };
    },
    async close() {
      const results = await Promise.allSettled([...handlers].map(handler => handler.close()));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Reverse tools shutdown failed');
    },
  };
}
