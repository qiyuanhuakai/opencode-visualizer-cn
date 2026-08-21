import type {
  BackendMessageSendParams,
  RequestGuard,
  SendPreflight,
} from './backendMessageSend.types';

export type OpenCodeExecutionResult =
  | { readonly kind: 'stale' }
  | { readonly kind: 'command' }
  | { readonly kind: 'no-directory' }
  | { readonly kind: 'prompt' };

function resolveOpenCodeAgent(params: BackendMessageSendParams, preflight: SendPreflight) {
  const parsedAtAgent = preflight.hasText ? params.parseAtAgent(preflight.text) : null;
  const agentMatch = parsedAtAgent ? params.findAgentByName(parsedAtAgent.agent) : null;
  return {
    parsedAtAgent,
    agentMatch,
    messageText: preflight.transformText(agentMatch ? (parsedAtAgent?.text ?? '') : preflight.text),
  };
}

async function buildOpenCodeParts(
  params: BackendMessageSendParams,
  preflight: SendPreflight,
  guard: RequestGuard,
  messageText: string,
): Promise<Record<string, unknown>[] | null> {
  const parts: Record<string, unknown>[] = [];
  if (preflight.hasText && messageText) parts.push({ type: 'text', text: messageText });
  if (preflight.backend === 'acp' && messageText) {
    if (!guard.isCurrent()) return null;
    parts.push(...(await params.buildAcpMentionContextParts(messageText)));
    if (!guard.isCurrent()) return null;
  }
  for (const item of preflight.attachments) {
    if (item.lineComment) {
      parts.push({
        type: 'text',
        text: params.formatCommentNote(
          item.lineComment.path,
          item.lineComment.startLine,
          item.lineComment.endLine,
          item.lineComment.text,
        ),
      });
      parts.push({
        type: 'file',
        mime: 'text/plain',
        url: params.buildLineCommentFileUrl(
          item.lineComment.path,
          item.lineComment.startLine,
          item.lineComment.endLine,
        ),
        filename: item.filename.split(':')[0] || item.filename,
      });
      continue;
    }
    parts.push({ type: 'file', mime: item.mime, url: item.dataUrl, filename: item.filename });
  }
  return parts;
}

export async function runOpenCodeSend(
  params: BackendMessageSendParams,
  preflight: SendPreflight,
  guard: RequestGuard,
): Promise<OpenCodeExecutionResult> {
  if (preflight.slash && preflight.commandMatch) {
    if (!guard.isCurrent()) return { kind: 'stale' };
    await params.sendCommand(
      preflight.sessionId,
      preflight.commandMatch,
      preflight.transformText(preflight.slash.arguments),
    );
    return guard.isCurrent() ? { kind: 'command' } : { kind: 'stale' };
  }
  const agent = resolveOpenCodeAgent(params, preflight);
  const directory = params.requireSelectedWorktree('send');
  if (!directory) return { kind: 'no-directory' };
  const parts = await buildOpenCodeParts(params, preflight, guard, agent.messageText);
  if (!parts || !guard.isCurrent()) return { kind: 'stale' };
  await params.openCodeApi.sendPromptAsync(preflight.sessionId, {
    directory,
    agent: agent.agentMatch?.name ?? params.resolveAgentMode(preflight.selectedMode),
    model: {
      providerID: preflight.modelProvider,
      modelID: preflight.modelId || '',
    },
    variant: preflight.selectedThinking,
    parts,
  });
  return guard.isCurrent() ? { kind: 'prompt' } : { kind: 'stale' };
}
