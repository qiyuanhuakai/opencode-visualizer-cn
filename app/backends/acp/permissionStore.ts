import type {
  CodexJsonRpcClient,
  CodexJsonRpcId,
  CodexJsonRpcServerRequest,
} from '../codex/jsonRpcClient';
import { parsePermissionRequest, type AcpPermissionOption } from './wire';

export type AcpPermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool: { messageID: string; callID: string };
};

type PendingPermission = {
  rpcId: CodexJsonRpcId;
  request: AcpPermissionRequest;
  options: AcpPermissionOption[];
};

export class AcpPermissionStore {
  private readonly pending = new Map<string, PendingPermission>();

  constructor(
    private readonly client: CodexJsonRpcClient,
    private readonly getAssistantMessageId: (sessionId: string) => string,
    private readonly onRequest: (request: AcpPermissionRequest) => void,
  ) {}

  handleServerRequest(request: CodexJsonRpcServerRequest) {
    if (request.method !== 'session/request_permission') {
      this.client.respondError(
        request.id,
        -32601,
        `Unsupported ACP client method: ${request.method}`,
      );
      return;
    }
    const params = parsePermissionRequest(request.params);
    if (!params) {
      this.client.respondError(request.id, -32602, 'Invalid ACP permission request.');
      return;
    }
    const id = String(request.id);
    const title =
      typeof params.toolCall.title === 'string' ? params.toolCall.title : 'Tool permission';
    const requestInfo: AcpPermissionRequest = {
      id,
      sessionID: params.sessionId,
      permission: title,
      patterns: [],
      metadata: { toolCall: params.toolCall, options: params.options },
      always: params.options.some((option) => option.kind === 'allow_always') ? ['*'] : [],
      tool: {
        messageID: this.getAssistantMessageId(params.sessionId),
        callID: params.toolCall.toolCallId,
      },
    };
    this.pending.set(id, { rpcId: request.id, request: requestInfo, options: params.options });
    this.onRequest(requestInfo);
  }

  list() {
    return [...this.pending.values()].map((pending) => pending.request);
  }

  clear() {
    this.pending.clear();
  }

  reply(requestId: string, reply: 'once' | 'always' | 'reject') {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error(`ACP permission request not found: ${requestId}`);
    const targetKind =
      reply === 'once' ? 'allow_once' : reply === 'always' ? 'allow_always' : 'reject_once';
    const option =
      pending.options.find((candidate) => candidate.kind === targetKind) ??
      (reply === 'reject'
        ? pending.options.find((candidate) => candidate.kind === 'reject_always')
        : undefined);
    if (!option) throw new Error(`ACP permission option is unavailable for reply: ${reply}`);
    this.client.respond(pending.rpcId, {
      outcome: { kind: 'selected', optionId: option.optionId },
    });
    this.pending.delete(requestId);
  }
}
