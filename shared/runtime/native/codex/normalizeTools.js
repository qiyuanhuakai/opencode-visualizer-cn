import { codexReasoningText } from './reasoning.js';
import { codexAgentName } from './agentName.js';
import {
  isRecord,
  stringValue,
  toolResultText,
  commandText,
  createToolPart,
  createFilePart,
  createReasoningPart,
  createCompactionPart,
} from './normalizeParts.js';
export function normalizeToolItem({ type, item, itemId, itemTime, assistantMessageId, sessionId }) {
  const parts = [];
  const params = { sessionId };
  (function append() {
    if (type === 'commandExecution') {
      const command = commandText(item);
      const output = stringValue(item.aggregatedOutput) || stringValue(item.output);
      const status = stringValue(item.status);
      parts.push(
        createToolPart({
          id: itemId,
          sessionId: params.sessionId,
          messageId: assistantMessageId,
          tool: 'bash',
          title: command || 'Codex command',
          input: { command, cwd: stringValue(item.cwd) },
          output,
          createdAt: itemTime,
          status,
        }),
      );
      return;
    }
    if (type === 'fileChange') {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
      const files = changes.map((change) => stringValue(change.path)).filter(Boolean);
      const status = stringValue(item.status);
      const firstPath = files[0] || '';
      const changeResults = changes
        .map((change) => {
          const path = stringValue(change.path);
          const rawDiff = stringValue(change.diff).trim();
          const diff =
            rawDiff ||
            (path
              ? `## File changed\n\nPath: ${path}\n\nStatus: ${status || 'completed'}\n\n(Codex did not provide a unified diff.)`
              : `## File changed\n\nStatus: ${status || 'completed'}\n\n(Codex did not provide a unified diff.)`);
          return {
            path,
            diff,
            filediff: {
              patch: diff,
            },
          };
        })
        .filter((entry) => entry.path || entry.diff);
      const isMultiFile = changeResults.length > 1;
      parts.push(
        createToolPart({
          id: itemId,
          sessionId: params.sessionId,
          messageId: assistantMessageId,
          tool: isMultiFile ? 'multiedit' : 'edit',
          title: files.length > 0 ? `Codex file changes (${files.length})` : 'Codex file changes',
          input: { files, filePath: firstPath },
          output: changeResults
            .map((change) => change.diff)
            .filter(Boolean)
            .join('\n'),
          createdAt: itemTime,
          status,
          metadata: isMultiFile
            ? { results: changeResults }
            : { filediff: { patch: changeResults[0]?.diff || '' } },
        }),
      );
      return;
    }
    if (type === 'reasoning') {
      const text = codexReasoningText(item);
      if (!text) return;
      parts.push(
        createReasoningPart({
          id: itemId,
          sessionId: params.sessionId,
          messageId: assistantMessageId,
          text,
          createdAt: itemTime,
        }),
      );
      return;
    }
    if (type === 'plan') {
      return;
    }
    if (type === 'mcpToolCall') {
      const server = stringValue(item.server);
      const tool = stringValue(item.tool);
      const args = isRecord(item.arguments) ? item.arguments : {};
      const result = toolResultText(item.result);
      const error = toolResultText(item.error);
      const status = stringValue(item.status);
      parts.push(
        createToolPart({
          id: itemId,
          sessionId: params.sessionId,
          messageId: assistantMessageId,
          tool: tool || 'mcp',
          title: server && tool ? `${server}.${tool}` : tool || 'MCP tool call',
          input: { server, tool, ...args },
          output: error || result,
          createdAt: itemTime,
          status,
        }),
      );
      return;
    }
    if (type === 'subAgentActivity') {
      const childId = stringValue(item.agentThreadId);
      const agentPath = stringValue(item.agentPath);
      const agentName = codexAgentName(agentPath);
      const kind = stringValue(item.kind);
      const status = kind === 'completed' || kind === 'interrupted' ? kind : 'running';
      parts.push(
        createToolPart({
          id: itemId,
          sessionId: params.sessionId,
          messageId: assistantMessageId,
          tool: 'task',
          title: agentName || 'Codex agent',
          input: { operation: kind, prompt: agentName },
          output: [kind, agentName].filter(Boolean).join('\n'),
          createdAt: itemTime,
          status: 'completed',
          metadata: {
            sessionId: childId,
            sessionIds: childId ? [childId] : [],
            agentPath,
            senderThreadId: params.sessionId,
            agentsStates: childId ? { [childId]: { status } } : {},
          },
        }),
      );
      return;
    }
    if (type === 'collabToolCall' || type === 'collabAgentToolCall') {
      const tool = stringValue(item.tool);
      const receiverIds = Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.filter((id) => typeof id === 'string' && !!id.trim())
        : [stringValue(item.newThreadId) || stringValue(item.receiverThreadId)].filter(Boolean);
      const agentsStates = isRecord(item.agentsStates) ? item.agentsStates : {};
      const prompt = stringValue(item.prompt);
      parts.push(
        createToolPart({
          id: itemId,
          sessionId: params.sessionId,
          messageId: assistantMessageId,
          tool: 'task',
          title: tool || 'Codex agent',
          input: {
            operation: tool,
            prompt,
            model: item.model,
            reasoningEffort: item.reasoningEffort,
          },
          output:
            Object.entries(agentsStates)
              .map(([id, state]) => `${id}: ${JSON.stringify(state)}`)
              .join('\n') || stringValue(item.status),
          createdAt: itemTime,
          status: stringValue(item.status),
          metadata: {
            sessionIds: receiverIds,
            sessionId: receiverIds[0],
            agentsStates,
            senderThreadId: item.senderThreadId,
          },
        }),
      );
      return;
    }
    if (type === 'dynamicToolCall') {
      const tool = stringValue(item.tool);
      const args = isRecord(item.arguments) ? item.arguments : {};
      const status = stringValue(item.status);
      const contentItems = Array.isArray(item.contentItems) ? item.contentItems : [];
      const outputText = contentItems
        .filter(isRecord)
        .map((ci) => stringValue(ci.text))
        .filter(Boolean)
        .join('\n');
      parts.push(
        createToolPart({
          id: itemId,
          sessionId: params.sessionId,
          messageId: assistantMessageId,
          tool: tool || 'dynamic',
          title: tool || 'Dynamic tool call',
          input: args,
          output: outputText || status,
          createdAt: itemTime,
          status,
        }),
      );
      return;
    }
    if (type === 'webSearch') {
      const query = stringValue(item.query);
      const action = isRecord(item.action) ? item.action : null;
      const actionType = action ? stringValue(action.type) : '';
      const actionUrl = action ? stringValue(action.url) : '';
      const status = stringValue(item.status);
      parts.push(
        createToolPart({
          id: itemId,
          sessionId: params.sessionId,
          messageId: assistantMessageId,
          tool: 'websearch',
          title: query || actionUrl || 'Codex web search',
          input: {
            query,
            ...(actionType ? { action: actionType } : {}),
            ...(actionUrl ? { url: actionUrl } : {}),
          },
          output: [
            query ? `Query: ${query}` : '',
            actionType ? `Action: ${actionType}` : '',
            actionUrl ? `URL: ${actionUrl}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          createdAt: itemTime,
          status,
        }),
      );
      return;
    }
    if (type === 'imageView') {
      const path = stringValue(item.path);
      if (!path) return;
      parts.push(
        createFilePart({
          id: itemId,
          sessionId: params.sessionId,
          messageId: assistantMessageId,
          mime: 'image/*',
          filename: path.split(/[\\/]/u).filter(Boolean).pop() || 'image',
          url: path,
        }),
      );
      return;
    }
    if (type === 'enteredReviewMode' || type === 'exitedReviewMode') {
      return;
    }
    if (type === 'contextCompaction') {
      parts.push(
        createCompactionPart({
          id: itemId,
          sessionId: params.sessionId,
          messageId: assistantMessageId,
          createdAt: itemTime,
        }),
      );
      return;
    }
  })();
  return parts;
}
