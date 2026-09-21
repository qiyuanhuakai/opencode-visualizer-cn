import type { KimiWebNormalizeOp, KimiWebNormalizeResult } from '../backends/kimiWeb/normalize';
import type { MessageInfo } from '../types/sse';
import { reconcilePartKind } from './kimiWebMessageReconcile';
import type { KimiWebMessageBridgeOptions, KimiWebSessionPatch } from './kimiWebMessageBridgeTypes';

export type KimiWebFrameOrigin = 'live' | 'durable-replay' | 'snapshot-rebuild';

type OpApplierOptions = {
  bridge: KimiWebMessageBridgeOptions;
  messages: Map<string, MessageInfo>;
  ownMessage(sessionId: string, info: MessageInfo): void;
  mergeSession(sessionId: string, patch: KimiWebSessionPatch): void;
};

export function createKimiWebOpApplier(context: OpApplierOptions) {
  function applyLivePart(
    op: Extract<KimiWebNormalizeOp, { kind: 'part' }>,
    result: KimiWebNormalizeResult,
    info: MessageInfo | undefined,
  ) {
    if (op.part.type === 'tool') context.bridge.onToolPart?.(op.part);
    else if (info && op.part.sessionID !== result.sessionId) context.bridge.onLiveSubagent?.(info, op.part);
    else if (info && op.part.type === 'reasoning') context.bridge.onLiveReasoning?.(info, op.part);
  }

  function applyPart(
    op: Extract<KimiWebNormalizeOp, { kind: 'part' }>,
    result: KimiWebNormalizeResult,
    origin: KimiWebFrameOrigin,
  ) {
    context.bridge.msg.updatePart(op.part);
    const info = context.messages.get(op.part.messageID);
    if (origin === 'live') {
      applyLivePart(op, result, info);
      return;
    }
    const kind = reconcilePartKind(info, op.part, result.sessionId);
    if (info && kind) context.bridge.onReconcilePart?.(info, op.part, kind);
  }

  function applySessionOp(op: Exclude<KimiWebNormalizeOp, { kind: 'message' | 'part' }>) {
    if (op.kind === 'turn') {
      if (op.phase === 'ended' && (op.reason === 'completed' || op.reason === 'cancelled' || op.reason === 'failed')) {
        context.mergeSession(op.sessionId, { completion: { reason: op.reason, error: op.error } });
      }
      return;
    }
    if (op.kind === 'step') {
      context.mergeSession(op.sessionId, { step: op });
      return;
    }
    if (op.kind === 'agent') {
      if (op.phase === 'status' && op.status) {
        context.mergeSession(op.sessionId, {
          usage: op.status.usage,
          contextTokens: op.status.contextTokens,
          maxContextTokens: op.status.maxContextTokens,
          planMode: op.status.planMode,
        });
      }
      return;
    }
    if (op.kind === 'session') {
      context.mergeSession(op.sessionId, {
        busy: op.busy,
        mainTurnActive: op.mainTurnActive,
        pendingInteraction: op.pendingInteraction,
        lastTurnReason: op.lastTurnReason,
        status: op.status,
        currentPromptId: op.currentPromptId,
      });
      context.bridge.onSessionEvent?.(op);
    }
  }

  return (op: KimiWebNormalizeOp, result: KimiWebNormalizeResult, origin: KimiWebFrameOrigin) => {
    if (op.kind === 'message') {
      context.messages.set(op.message.id, op.message);
      context.ownMessage(result.sessionId ?? op.message.sessionID, op.message);
      context.bridge.msg.updateMessage(op.message);
      return;
    }
    if (op.kind === 'part') {
      applyPart(op, result, origin);
      return;
    }
    applySessionOp(op);
  };
}
