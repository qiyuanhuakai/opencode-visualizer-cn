/**
 * Neutral operation union emitted by the kimi-web normalizer. Todo 14 applies
 * these to the shared message store; no shared contract types are redefined.
 */
import type { MessageInfo, MessagePart } from '../../types/sse';
import type {
  KimiWebAgentStatus,
  KimiWebPayload,
  KimiWebTurnError,
  KimiWebTurnReason,
  KimiWebUsage,
} from './wire';

export type KimiWebNormalizeOp =
  | { kind: 'message'; message: MessageInfo }
  | { kind: 'part'; part: MessagePart; delta?: string }
  | { kind: 'turn'; phase: 'started' | 'ended'; sessionId: string; agentId: string; turnId: number; time: number;
      reason?: KimiWebTurnReason; error?: KimiWebTurnError; promptId?: string; durationMs?: number; interruptReason?: string }
  | { kind: 'step'; phase: 'started' | 'completed' | 'retrying' | 'interrupted'; sessionId: string; agentId: string;
      turnId: number; step: number; stepId?: string; usage?: KimiWebUsage; reason?: string; message?: string;
      failedAttempt?: number; nextAttempt?: number; maxAttempts?: number; delayMs?: number; errorName?: string;
      errorMessage?: string; statusCode?: number }
  | { kind: 'agent'; phase: 'created' | 'disposed' | 'status'; sessionId: string; agentId: string; status?: KimiWebAgentStatus }
  | { kind: 'session'; phase: 'meta' | 'created' | 'archived' | 'deleted' | 'work-changed' | 'status-changed'; sessionId: string;
      title?: string; patch?: KimiWebPayload; session?: unknown; workspaceId?: string; busy?: boolean; mainTurnActive?: boolean;
      pendingInteraction?: string; lastTurnReason?: string; status?: string; previousStatus?: string; currentPromptId?: string }
  | { kind: 'prompt'; phase: 'submitted' | 'started' | 'completed' | 'aborted' | 'steered'; sessionId: string; agentId: string;
      promptId?: string; userMessageId?: string; status?: string; reason?: string; abortedAt?: string; steeredAt?: string;
      activePromptId?: string; promptIds?: string[] }
  | { kind: 'interaction'; interaction: 'approval' | 'question'; phase: 'requested' | 'resolved' | 'answered' | 'dismissed';
      sessionId: string; agentId: string; id: string; turnId?: number; toolCallId?: string; toolName?: string; action?: string;
      questions?: unknown[]; decision?: string; scope?: string; feedback?: string; selectedLabel?: string; answers?: unknown;
      createdAt?: string; expiresAt?: string; resolvedAt?: string }
  | { kind: 'subagent'; phase: 'spawned' | 'started' | 'suspended' | 'completed' | 'failed'; sessionId: string; agentId: string;
      subagentId: string; subagentSessionId: string; name?: string; description?: string; parentToolCallId?: string;
      runInBackground?: boolean; model?: string; resultSummary?: string; error?: string; usage?: KimiWebUsage;
      contextTokens?: number; time: number }
  | { kind: 'compaction'; phase: 'started' | 'blocked' | 'cancelled' | 'completed'; sessionId: string; agentId: string;
      trigger?: string; instruction?: string; turnId?: number; result?: KimiWebPayload; time: number }
  | { kind: 'error' | 'warning'; sessionId?: string; agentId?: string; code?: string; message: string; retryable?: boolean;
      details?: KimiWebPayload; system?: boolean; time: number };

export type KimiWebNormalizeResult = {
  eventType: string;
  sessionId?: string;
  volatile: boolean;
  ops: KimiWebNormalizeOp[];
};

export type KimiWebNormalizeStats = {
  frames: number;
  unknownEventCount: number;
  ignoredEventCount: number;
  staleDeltaCount: number;
  duplicateDeltaCount: number;
};

export type KimiWebNormalizer = {
  ingest(frame: unknown): KimiWebNormalizeResult;
  stats(): KimiWebNormalizeStats;
  reset(): void;
  subagentSessionId(sessionId: string, agentId: string, turnId?: number): string;
};
