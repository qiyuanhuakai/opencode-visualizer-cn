/**
 * Kimi Web approvals / questions (Todo 19).
 *
 * Wires `event.approval.*` / `event.question.*` into the EXISTING shared
 * permission/question surfaces (`usePermissions` / `useQuestions` in App.vue —
 * same floating windows the OpenCode/Codex/ACP paths use).
 *
 * Reconciliation is AUTHORITATIVE, never unconditional cleanup:
 * - pending interactions are tracked per `{session_id, interaction_id}`;
 * - `requested` upserts, `resolved` / `answered` / `dismissed` clear ONLY the
 *   matching id, so a late event can never drop a newer pending item;
 * - the pending SET is rebuilt from the server lists (`listApprovals` /
 *   `listQuestions`, both `status=pending`) on initial load, on reconnect and
 *   after an answer that failed with "already resolved";
 * - turn completion (`turn.ended`) and the session-level pending declaration
 *   (`pending_interaction` / `status: awaiting_*`) are kept SEPARATE from the
 *   item set: a finished turn never implies "no pending interaction", and a
 *   session-level declaration never fabricates or clears an item.
 *
 * This module is pure (no Vue, no fetch, no storage): App.vue wires it to refs,
 * the Todo 8 REST client and the App-owned WS client. Permission payloads stay
 * memory-only (project rule) — nothing here persists.
 */
import { createKimiWebNormalizer } from './normalize';
import type { KimiWebNormalizeOp } from './ops';
import {
  type KimiWebAnswerApprovalInput,
  type KimiWebAnswerQuestionInput,
  type KimiWebApproval,
  type KimiWebClient,
  type KimiWebQuestion,
  type KimiWebQuestionAnswer,
  type KimiWebQuestionItem,
} from '../../utils/kimiWeb';
import type { KimiWebWsAck, KimiWebWsFrame } from '../../utils/kimiWebWs';
import type { QuestionRequest } from '../../types/sse';
import type { PermissionRequest } from '../../composables/usePermissions';

export type KimiWebInteractionKind = 'approval' | 'question';
export type KimiWebInteractionPhase = 'requested' | 'resolved' | 'answered' | 'dismissed';

/** Normalized interaction event (bridge op shape; consumed by the store). */
export type KimiWebInteractionEvent = {
  kind: KimiWebInteractionKind;
  phase: KimiWebInteractionPhase;
  sessionId: string;
  id: string;
  turnId?: number;
  toolCallId?: string;
  toolName?: string;
  action?: string;
  questions?: KimiWebQuestionItem[];
  createdAt?: string;
  expiresAt?: string;
};

export type KimiWebPendingApproval = {
  kind: 'approval';
  sessionId: string;
  id: string;
  toolName?: string;
  action?: string;
  toolCallId?: string;
  turnId?: number;
  createdAt?: string;
  expiresAt?: string;
  /** REST-only richer display input; memory-only, never persisted. */
  toolInputDisplay?: unknown;
  source: 'event' | 'rest';
};

export type KimiWebPendingQuestion = {
  kind: 'question';
  sessionId: string;
  id: string;
  questions: KimiWebQuestionItem[];
  toolCallId?: string;
  turnId?: number;
  createdAt?: string;
  source: 'event' | 'rest';
};

export type KimiWebPendingInteraction = KimiWebPendingApproval | KimiWebPendingQuestion;

export type KimiWebInteractionStore = {
  /** Normalizes a raw wire frame; returns the interaction event (or null). */
  ingestFrame(frame: KimiWebWsFrame): KimiWebInteractionEvent | null;
  /** Applies a normalized event (pure transition). */
  ingestEvent(event: KimiWebInteractionEvent): void;
  /**
   * Rebuilds the session's slice from the authoritative server lists.
   * `sinceRevision` retains event-sourced items ingested after the fetch
   * started, so an interaction created mid-reconcile is never dropped.
   */
  applyAuthoritative(input: {
    sessionId: string;
    approvals: readonly KimiWebApproval[];
    questions: readonly KimiWebQuestion[];
    sinceRevision?: number;
  }): void;
  pendingFor(sessionId: string): KimiWebPendingInteraction[];
  /** Session-level view mirroring the wire `pending_interaction` declaration. */
  pendingKind(sessionId: string): KimiWebInteractionKind | 'none';
  findById(id: string): KimiWebPendingInteraction | undefined;
  remove(sessionId: string, id: string): boolean;
  clearSession(sessionId: string): void;
  clearAll(): void;
  /** Monotonic mutation counter used for the reconcile race fence. */
  revision(): number;
  size(): number;
};

type StoreEntry = { item: KimiWebPendingInteraction; revision: number };

function entryKey(sessionId: string, id: string): string {
  return `${sessionId}\u0000${id}`;
}

function normalizeQuestionItems(raw: unknown): KimiWebQuestionItem[] {
  if (!Array.isArray(raw)) return [];
  const items: KimiWebQuestionItem[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const question = typeof record.question === 'string' ? record.question.trim() : '';
    if (!id || !question) continue;
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          if (!option || typeof option !== 'object') return [];
          const entry = option as Record<string, unknown>;
          const optionId = typeof entry.id === 'string' ? entry.id.trim() : '';
          const label = typeof entry.label === 'string' ? entry.label.trim() : '';
          if (!optionId || !label) return [];
          return [{
            id: optionId,
            label,
            ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
          }];
        })
      : [];
    items.push({
      id,
      question,
      ...(typeof record.header === 'string' && record.header.trim() ? { header: record.header.trim() } : {}),
      ...(typeof record.body === 'string' && record.body.trim() ? { body: record.body.trim() } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(record.multi_select === true ? { multi_select: true } : {}),
      ...(record.allow_other === true ? { allow_other: true } : {}),
      ...(typeof record.other_label === 'string' ? { other_label: record.other_label } : {}),
      ...(typeof record.other_description === 'string'
        ? { other_description: record.other_description }
        : {}),
    });
  }
  return items;
}

function eventFromInteractionOp(
  op: Extract<KimiWebNormalizeOp, { kind: 'interaction' }>,
): KimiWebInteractionEvent | null {
  if (!op.id || !op.sessionId) return null;
  const base = {
    sessionId: op.sessionId,
    id: op.id,
    turnId: op.turnId,
    toolCallId: op.toolCallId,
  };
  if (op.interaction === 'approval') {
    if (op.phase === 'requested') {
      return {
        kind: 'approval',
        phase: 'requested',
        ...base,
        toolName: op.toolName,
        action: op.action,
        createdAt: op.createdAt,
        expiresAt: op.expiresAt,
      };
    }
    return { kind: 'approval', phase: 'resolved', ...base };
  }
  if (op.phase === 'requested') {
    const questions = normalizeQuestionItems(op.questions);
    if (questions.length === 0) return null;
    return { kind: 'question', phase: 'requested', ...base, questions, createdAt: op.createdAt };
  }
  return { kind: 'question', phase: op.phase, ...base };
}

export function createKimiWebInteractionStore(): KimiWebInteractionStore {
  const normalizer = createKimiWebNormalizer();
  const entries = new Map<string, StoreEntry>();
  let revision = 0;

  function touch(): number {
    revision += 1;
    return revision;
  }

  function ingestEvent(event: KimiWebInteractionEvent): void {
    const stamp = touch();
    if (event.phase === 'requested') {
      if (event.kind === 'approval') {
        // Map.set keeps the insertion order of an existing key, so a re-request
        // of the same id refreshes the payload in place.
        entries.set(entryKey(event.sessionId, event.id), {
          item: {
            kind: 'approval',
            sessionId: event.sessionId,
            id: event.id,
            toolName: event.toolName,
            action: event.action,
            toolCallId: event.toolCallId,
            turnId: event.turnId,
            createdAt: event.createdAt,
            expiresAt: event.expiresAt,
            source: 'event',
          },
          revision: stamp,
        });
        return;
      }
      entries.set(entryKey(event.sessionId, event.id), {
        item: {
          kind: 'question',
          sessionId: event.sessionId,
          id: event.id,
          questions: event.questions ?? [],
          toolCallId: event.toolCallId,
          turnId: event.turnId,
          createdAt: event.createdAt,
          source: 'event',
        },
        revision: stamp,
      });
      return;
    }
    // resolved / answered / dismissed: clear ONLY the matching id.
    entries.delete(entryKey(event.sessionId, event.id));
  }

  function pendingFor(sessionId: string): KimiWebPendingInteraction[] {
    const pending: KimiWebPendingInteraction[] = [];
    for (const entry of entries.values()) {
      if (entry.item.sessionId === sessionId) pending.push(entry.item);
    }
    return pending;
  }

  return {
    ingestFrame(frame: KimiWebWsFrame): KimiWebInteractionEvent | null {
      const result = normalizer.ingest(frame);
      for (const op of result.ops) {
        if (op.kind !== 'interaction') continue;
        const event = eventFromInteractionOp(op);
        if (!event) continue;
        ingestEvent(event);
        return event;
      }
      return null;
    },
    ingestEvent,
    applyAuthoritative(input) {
      const stamp = touch();
      const next = new Map<string, StoreEntry>();
      for (const [key, entry] of entries) {
        if (entry.item.sessionId !== input.sessionId) {
          next.set(key, entry);
          continue;
        }
        // Race fence: interactions requested while the lists were in flight
        // (revision newer than the fetch) survive the rebuild.
        if (input.sinceRevision !== undefined && entry.revision > input.sinceRevision) {
          next.set(key, entry);
        }
      }
      for (const approval of input.approvals) {
        if (!approval?.approval_id) continue;
        next.set(entryKey(input.sessionId, approval.approval_id), {
          item: {
            kind: 'approval',
            sessionId: input.sessionId,
            id: approval.approval_id,
            toolName: approval.tool_name,
            action: approval.action,
            toolCallId: approval.tool_call_id,
            turnId: approval.turn_id,
            createdAt: approval.created_at,
            expiresAt: approval.expires_at ?? undefined,
            toolInputDisplay: approval.tool_input_display,
            source: 'rest',
          },
          revision: stamp,
        });
      }
      for (const question of input.questions) {
        if (!question?.question_id) continue;
        const items = normalizeQuestionItems(question.questions);
        if (items.length === 0) continue;
        next.set(entryKey(input.sessionId, question.question_id), {
          item: {
            kind: 'question',
            sessionId: input.sessionId,
            id: question.question_id,
            questions: items,
            toolCallId: question.tool_call_id,
            turnId: question.turn_id,
            createdAt: question.created_at,
            source: 'rest',
          },
          revision: stamp,
        });
      }
      entries.clear();
      for (const [key, entry] of next) entries.set(key, entry);
    },
    pendingFor,
    pendingKind(sessionId: string): KimiWebInteractionKind | 'none' {
      const pending = pendingFor(sessionId);
      if (pending.length === 0) return 'none';
      return pending[0].kind;
    },
    findById(id: string) {
      for (const entry of entries.values()) {
        if (entry.item.id === id) return entry.item;
      }
      return undefined;
    },
    remove(sessionId: string, id: string) {
      return entries.delete(entryKey(sessionId, id));
    },
    clearSession(sessionId: string) {
      for (const [key, entry] of entries) {
        if (entry.item.sessionId === sessionId) entries.delete(key);
      }
    },
    clearAll() {
      entries.clear();
    },
    revision: () => revision,
    size: () => entries.size,
  };
}

// ---------------------------------------------------------------------------
// Endpoint payloads (pure builders + validation; malformed input never POSTs)
// ---------------------------------------------------------------------------

const APPROVAL_DECISIONS = new Set(['approved', 'rejected', 'cancelled']);

export type KimiWebPermissionReply = 'once' | 'always' | 'reject';

/** Shared permission replies -> kimi approval answer. */
export function kimiWebApprovalAnswerFromReply(
  reply: string,
): KimiWebAnswerApprovalInput | null {
  if (reply === 'once') return { decision: 'approved' };
  if (reply === 'always') return { decision: 'approved', scope: 'session' };
  if (reply === 'reject') return { decision: 'rejected' };
  return null;
}

function isApprovalAnswer(answer: KimiWebAnswerApprovalInput): boolean {
  if (!answer || typeof answer !== 'object') return false;
  if (typeof answer.decision !== 'string' || !APPROVAL_DECISIONS.has(answer.decision)) return false;
  if (answer.scope !== undefined && answer.scope !== 'session') return false;
  if (answer.feedback !== undefined && typeof answer.feedback !== 'string') return false;
  if (answer.selected_label !== undefined && typeof answer.selected_label !== 'string') return false;
  return true;
}

function isQuestionAnswer(value: unknown): value is KimiWebQuestionAnswer {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case 'single':
      return typeof record.option_id === 'string' && record.option_id.length > 0;
    case 'multi':
      return (
        Array.isArray(record.option_ids) &&
        record.option_ids.every((entry) => typeof entry === 'string' && entry.length > 0)
      );
    case 'other':
      return typeof record.text === 'string' && record.text.length > 0;
    case 'multi_with_other':
      return (
        Array.isArray(record.option_ids) &&
        record.option_ids.every((entry) => typeof entry === 'string' && entry.length > 0) &&
        typeof record.other_text === 'string' &&
        record.other_text.length > 0
      );
    case 'skipped':
      return true;
    default:
      return false;
  }
}

function isQuestionAnswerInput(answer: KimiWebAnswerQuestionInput): boolean {
  if (!answer || typeof answer !== 'object') return false;
  const answers = answer.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return false;
  const values = Object.values(answers);
  if (values.length === 0) return false;
  return values.every(isQuestionAnswer);
}

/**
 * Maps the shared question window's label-based answers back onto the kimi
 * option ids (the shared `QuestionRequest` shape carries labels only).
 */
export function kimiWebQuestionAnswersFromLabels(
  question: KimiWebPendingQuestion,
  labelAnswers: readonly string[][],
): KimiWebAnswerQuestionInput | null {
  const answers: Record<string, KimiWebQuestionAnswer> = {};
  let answered = 0;
  question.questions.forEach((item, index) => {
    const labels = Array.isArray(labelAnswers[index]) ? labelAnswers[index] : [];
    const optionIds: string[] = [];
    const others: string[] = [];
    for (const label of labels) {
      const option = item.options?.find((entry) => entry.label === label);
      if (option) optionIds.push(option.id);
      else others.push(label);
    }
    const otherText = others.join('\n').trim();
    let answer: KimiWebQuestionAnswer;
    if (item.multi_select === true) {
      if (optionIds.length > 0 && otherText) {
        answer = { kind: 'multi_with_other', option_ids: optionIds, other_text: otherText };
      } else if (optionIds.length > 0) {
        answer = { kind: 'multi', option_ids: optionIds };
      } else if (otherText) {
        answer = { kind: 'other', text: otherText };
      } else {
        answer = { kind: 'skipped' };
      }
    } else if (optionIds.length > 0) {
      answer = { kind: 'single', option_id: optionIds[0] };
    } else if (otherText) {
      answer = { kind: 'other', text: otherText };
    } else {
      answer = { kind: 'skipped' };
    }
    if (answer.kind !== 'skipped') answered += 1;
    answers[item.id] = answer;
  });
  if (answered === 0) return null;
  return { answers };
}

// ---------------------------------------------------------------------------
// Shared UI shapes (memory-only; same components as OpenCode/Codex/ACP)
// ---------------------------------------------------------------------------

export const KIMI_WEB_APPROVAL_REQUEST_PREFIX = 'kimi-web-approval:';
export const KIMI_WEB_QUESTION_REQUEST_PREFIX = 'kimi-web-question:';

export function kimiWebApprovalRequestId(approvalId: string): string {
  return `${KIMI_WEB_APPROVAL_REQUEST_PREFIX}${approvalId}`;
}

export function kimiWebQuestionRequestId(questionId: string): string {
  return `${KIMI_WEB_QUESTION_REQUEST_PREFIX}${questionId}`;
}

export function parseKimiWebApprovalRequestId(requestId: string): string | null {
  if (!requestId.startsWith(KIMI_WEB_APPROVAL_REQUEST_PREFIX)) return null;
  const id = requestId.slice(KIMI_WEB_APPROVAL_REQUEST_PREFIX.length);
  return id.length > 0 ? id : null;
}

export function parseKimiWebQuestionRequestId(requestId: string): string | null {
  if (!requestId.startsWith(KIMI_WEB_QUESTION_REQUEST_PREFIX)) return null;
  const id = requestId.slice(KIMI_WEB_QUESTION_REQUEST_PREFIX.length);
  return id.length > 0 ? id : null;
}

export function kimiWebApprovalToPermissionRequest(
  item: KimiWebPendingApproval,
): PermissionRequest {
  const action = item.action?.trim() ?? '';
  return {
    id: kimiWebApprovalRequestId(item.id),
    sessionID: item.sessionId,
    permission: item.toolName?.trim() || action || 'approval',
    patterns: action ? [action] : [],
    metadata: item.toolInputDisplay === undefined ? {} : { tool_input_display: item.toolInputDisplay },
    // `always` exposes the kimi session-scope decision on the shared window.
    always: action ? [action] : [],
    ...(item.toolCallId ? { tool: { messageID: item.toolCallId, callID: item.toolCallId } } : {}),
  };
}

export function kimiWebQuestionToQuestionRequest(
  item: KimiWebPendingQuestion,
): QuestionRequest {
  return {
    id: kimiWebQuestionRequestId(item.id),
    sessionID: item.sessionId,
    questions: item.questions.map((entry) => ({
      question: entry.question,
      header: entry.header ?? entry.question,
      options: (entry.options ?? []).map((option) => ({
        label: option.label,
        description: option.description ?? '',
      })),
      multiple: entry.multi_select === true,
      custom: entry.allow_other !== false,
      secret: false,
    })),
  };
}

// ---------------------------------------------------------------------------
// Authoritative reconcile + answer/dismiss orchestration (injected deps)
// ---------------------------------------------------------------------------

export type KimiWebInteractionClient = Pick<
  KimiWebClient,
  'getSessionStatus' | 'listApprovals' | 'listQuestions' | 'answerApproval' | 'answerQuestion' | 'dismissQuestion'
>;

export type KimiWebReconcileResult =
  | { ok: true; refetched: boolean }
  | { ok: false; refetched: boolean; error: unknown };

/** Reads the session-level pending declaration; absent on measured 0.43.0 status. */
function declaredPendingInteraction(status: unknown): KimiWebInteractionKind | 'none' {
  if (!status || typeof status !== 'object') return 'none';
  const value = (status as Record<string, unknown>).pending_interaction;
  return value === 'approval' || value === 'question' ? value : 'none';
}

export type KimiWebSessionDeclaringOp = Extract<KimiWebNormalizeOp, { kind: 'session' }>;

// Session-state `pending_interaction` (bridge `onSessionEvent`) is a reconcile
// TRIGGER only, never a visibility source: it cannot fabricate or clear an item
// (authoritative lists own the set). `none` re-checks a stale local view; the
// lists still decide. An absent declaration never triggers.

export function kimiWebSessionOpNeedsReconcile(
  op: KimiWebSessionDeclaringOp,
  store: Pick<KimiWebInteractionStore, 'pendingFor'>,
): boolean {
  if (op.kind !== 'session') return false;
  const declared = op.pendingInteraction;
  if (declared === undefined) return false;
  const items = store.pendingFor(op.sessionId);
  if (declared === 'approval' || declared === 'question') {
    return !items.some((item) => item.kind === declared);
  }
  if (declared === 'none') return items.length > 0;
  return false;
}

/**
 * Rebuilds the session's pending set from the authoritative lists. Failures
 * leave the local set untouched (stale beats blank) and are reported.
 */
export async function reconcileKimiWebInteractions(options: {
  client: KimiWebInteractionClient;
  store: KimiWebInteractionStore;
  sessionId: string;
  isCurrent?: () => boolean;
}): Promise<KimiWebReconcileResult> {
  const { client, store, sessionId } = options;
  const since = store.revision();
  let status: unknown;
  let approvals: { items: KimiWebApproval[] };
  let questions: { items: KimiWebQuestion[] };
  try {
    [status, approvals, questions] = await Promise.all([
      // Session-level declaration is best-effort context only.
      client.getSessionStatus(sessionId).catch(() => undefined),
      client.listApprovals(sessionId),
      client.listQuestions(sessionId),
    ]);
  } catch (error) {
    return { ok: false, refetched: false, error };
  }
  if (options.isCurrent && !options.isCurrent()) return { ok: true, refetched: false };

  store.applyAuthoritative({
    sessionId,
    approvals: approvals?.items ?? [],
    questions: questions?.items ?? [],
    sinceRevision: since,
  });

  const declared = declaredPendingInteraction(status);
  if (declared === 'none' || store.pendingKind(sessionId) === declared) {
    return { ok: true, refetched: false };
  }
  // The session declares a pending interaction the first list read missed
  // (created between the two reads): refetch the item lists once.
  try {
    const [againApprovals, againQuestions] = await Promise.all([
      client.listApprovals(sessionId),
      client.listQuestions(sessionId),
    ]);
    if (options.isCurrent && !options.isCurrent()) return { ok: true, refetched: true };
    store.applyAuthoritative({
      sessionId,
      approvals: againApprovals?.items ?? [],
      questions: againQuestions?.items ?? [],
      sinceRevision: store.revision(),
    });
    return { ok: true, refetched: true };
  } catch (error) {
    return { ok: false, refetched: true, error };
  }
}

export type KimiWebAnswerResult =
  | { kind: 'answered' }
  | { kind: 'failed'; error: unknown };

async function convergeAfterFailedAnswer(options: {
  client: KimiWebInteractionClient;
  store: KimiWebInteractionStore;
  sessionId: string;
}): Promise<void> {
  try {
    await reconcileKimiWebInteractions(options);
  } catch {
    // The original answer error is the one surfaced to the user.
  }
}

export async function answerKimiWebApproval(options: {
  client: KimiWebInteractionClient;
  store: KimiWebInteractionStore;
  sessionId: string;
  approvalId: string;
  answer: KimiWebAnswerApprovalInput;
}): Promise<KimiWebAnswerResult> {
  const { client, store, sessionId, approvalId, answer } = options;
  if (!isApprovalAnswer(answer)) {
    return {
      kind: 'failed',
      error: new Error('Kimi Web approval answer is missing a valid decision.'),
    };
  }
  try {
    await client.answerApproval(sessionId, approvalId, answer);
  } catch (error) {
    // Another client (or a stale tab) may have resolved it first: converge to
    // the authoritative lists instead of guessing.
    await convergeAfterFailedAnswer({ client, store, sessionId });
    return { kind: 'failed', error };
  }
  store.remove(sessionId, approvalId);
  return { kind: 'answered' };
}

export async function answerKimiWebQuestion(options: {
  client: KimiWebInteractionClient;
  store: KimiWebInteractionStore;
  sessionId: string;
  questionId: string;
  answer: KimiWebAnswerQuestionInput;
}): Promise<KimiWebAnswerResult> {
  const { client, store, sessionId, questionId, answer } = options;
  if (!isQuestionAnswerInput(answer)) {
    return {
      kind: 'failed',
      error: new Error('Kimi Web question answer is missing valid answers.'),
    };
  }
  try {
    await client.answerQuestion(sessionId, questionId, answer);
  } catch (error) {
    await convergeAfterFailedAnswer({ client, store, sessionId });
    return { kind: 'failed', error };
  }
  store.remove(sessionId, questionId);
  return { kind: 'answered' };
}

export async function dismissKimiWebQuestion(options: {
  client: KimiWebInteractionClient;
  store: KimiWebInteractionStore;
  sessionId: string;
  questionId: string;
}): Promise<KimiWebAnswerResult> {
  const { client, store, sessionId, questionId } = options;
  try {
    await client.dismissQuestion(sessionId, questionId);
  } catch (error) {
    await convergeAfterFailedAnswer({ client, store, sessionId });
    return { kind: 'failed', error };
  }
  store.remove(sessionId, questionId);
  return { kind: 'answered' };
}

// ---------------------------------------------------------------------------
// WS frame attachment (App.vue owns the client; the bridge drops interaction
// ops, so this consumes the raw frames through the Todo 9 client interface and
// reuses the Todo 13/14 normalizer for payload parsing).
// ---------------------------------------------------------------------------

export function attachKimiWebInteractions(options: {
  client: KimiWebInteractionFrameSource;
  store: KimiWebInteractionStore;
  onInteractionsChanged: () => void;
  onReconnected: () => void;
}): () => void {
  const offFrame = options.client.onFrame((frame) => {
    if (options.store.ingestFrame(frame)) options.onInteractionsChanged();
  });
  const offReconnect = options.client.onReconnectReady(() => options.onReconnected());
  return () => {
    offFrame();
    offReconnect();
  };
}

export type KimiWebInteractionFrameSource = {
  onFrame(listener: (frame: KimiWebWsFrame) => void): () => void;
  onReconnectReady(listener: (ack: KimiWebWsAck) => void): () => void;
};
