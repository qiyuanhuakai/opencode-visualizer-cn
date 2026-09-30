/**
 * dsh prompt entries — requestId ↔ outer-rpcId binding, card identity and
 * per-turn diff refresh (plan Todo 20).
 *
 * Why this exists (docs/dsh.md §9, `.omo/evidence/dsh-adapt/04-session-follow-full.txt`):
 * `session/prompt` is fire-and-forget (`{accepted:true}`); the prompt request's
 * `requestId` is a required field of the payload, and the OUTER client-request
 * envelope's `rpcId` is what the server echoes back as `source.rpcId` on both
 * `agent/inbox/spliced` and `user/message` (seq 3/8). That echoed value is the
 * ONLY reliable response-binding key, so this module:
 *
 *   1. generates the `requestId` once and uses the SAME value as the envelope
 *      `rpcId` (`createDshPromptSend`), and
 *   2. binds the followed user message to the prompt by that outer `rpcId`
 *      (never by a local temp id, never by the inner `requestId` alone).
 *
 * Card identity is the SERVER user root message id (`user/message.id`), so a
 * re-render/refresh keeps the card in place and never repeats its fade-in; a
 * card fades in only for its FIRST assistant reply, and `turn/end` refreshes
 * that card's diff state. Duplicate records (normalizer seq gate) and duplicate
 * message ids never re-enter the list.
 *
 * Mirror of `app/backends/kimiWeb/promptEntries.ts`: the kimi side adopts the
 * real `prompt.submitted` user message id for the optimistic card; dsh has no
 * synchronous id, so the same adoption happens when the follow stream echoes
 * the rpcId. Shared `MessageInfo`/`MessagePart` contracts are never touched.
 */
import { buildDshClientRequest } from '../../utils/dshRpc';
import type { DshNormalizeOp, DshNormalizeResult, DshTurnReasonKind } from './ops';
import {
  isDshClientRequest,
  type DshClientRequest,
  type DshJsonValue,
  type DshPromptContentPart,
} from './types';

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------
// Send boundary: generate requestId and reuse it as the outer rpcId
// ---------------------------------------------------------------------------

export type DshPromptIdFactory = () => string;

const defaultRequestIdFactory: DshPromptIdFactory = () =>
  globalThis.crypto?.randomUUID?.() ?? `req-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;

export type DshPromptInput = {
  readonly sessionId: string;
  readonly content: readonly DshPromptContentPart[];
  readonly mode?: 'queue' | 'steer';
  readonly clientTimeZone?: string;
};

export type DshPromptSend = {
  /** Generated UUID; equals `request.rpcId` and `request.payload.args.requestId`. */
  readonly requestId: string;
  /** The `session/prompt` client-request envelope, ready for the send boundary. */
  readonly request: DshClientRequest;
};

/**
 * Build one `session/prompt` send. `newRequestId` is injectable so tests are
 * deterministic; production uses `crypto.randomUUID`. The returned envelope is
 * validated by `buildDshClientRequest`, so a non-JSON arg can never ship.
 */
export function createDshPromptSend(
  input: DshPromptInput,
  newRequestId: DshPromptIdFactory = defaultRequestIdFactory,
): DshPromptSend {
  const requestId = newRequestId();
  const args: Record<string, DshJsonValue> = {
    requestId,
    sessionId: input.sessionId,
    mode: input.mode ?? 'queue',
    content: input.content as unknown as DshJsonValue,
  };
  if (input.clientTimeZone !== undefined) args.clientTimeZone = input.clientTimeZone;
  return { requestId, request: buildDshClientRequest('session/prompt', args, requestId) };
}

// ---------------------------------------------------------------------------
// Card bookkeeping
// ---------------------------------------------------------------------------

/** `idle` → no turn yet; `pending` → turn running; `refreshed` → turn ended. */
export type DshPromptCardDiff = 'idle' | 'pending' | 'refreshed';

export type DshPromptCard = {
  readonly sessionId: string;
  readonly requestId: string;
  /** Server user root message id (`user/message.id`); undefined until bound. */
  readonly rootMessageId?: string;
  /** True once a followed user message was matched by `source.rpcId`. */
  readonly bound: boolean;
  /** True after this card's first reply faded in. */
  readonly faded: boolean;
  readonly diff: DshPromptCardDiff;
};

export type DshPromptEntryEffect =
  | { readonly kind: 'card-bound'; readonly sessionId: string; readonly requestId: string; readonly cardId: string }
  | { readonly kind: 'reply-fade-in'; readonly sessionId: string; readonly cardId: string; readonly replyId: string }
  | { readonly kind: 'card-refresh'; readonly sessionId: string; readonly cardId: string; readonly replyId: string }
  | {
      readonly kind: 'diff-refresh';
      readonly sessionId: string;
      readonly cardId: string;
      readonly reason: DshTurnReasonKind;
    };

type MutableCard = {
  sessionId: string;
  requestId: string;
  rootMessageId?: string;
  bound: boolean;
  faded: boolean;
  diff: DshPromptCardDiff;
};

export type DshPromptEntries = {
  /** Register a sent prompt. Throws if the envelope's inner requestId ≠ rpcId. */
  begin(send: DshPromptSend): void;
  /** Apply one normalizer result and return the card effects it produced. */
  ingest(result: DshNormalizeResult): DshPromptEntryEffect[];
  /** The card for a server root message id (undefined until bound). */
  card(rootMessageId: string): DshPromptCard | undefined;
  /** The still-unbound card for a requestId (undefined once bound). */
  pending(requestId: string): DshPromptCard | undefined;
  /** Every bound card. */
  cards(): readonly DshPromptCard[];
};

function snapshot(card: MutableCard): DshPromptCard {
  return {
    sessionId: card.sessionId,
    requestId: card.requestId,
    rootMessageId: card.rootMessageId,
    bound: card.bound,
    faded: card.faded,
    diff: card.diff,
  };
}

export function createDshPromptEntries(): DshPromptEntries {
  /** requestId → unbound card. */
  const pending = new Map<string, MutableCard>();
  /** server root message id → bound card. */
  const cardsByRoot = new Map<string, MutableCard>();
  /** sessionId → most recently bound card (its turn owns subsequent replies). */
  const activeBySession = new Map<string, MutableCard>();
  /** `${sessionId}:${replyId}` already associated; prevents re-fade + re-entry. */
  const seenReplies = new Set<string>();
  /** sessionId → a `turn/start` is open. */
  const openTurns = new Map<string, boolean>();

  function begin(send: DshPromptSend): void {
    const { rpcId, payload } = send.request;
    const args = payload.args;
    const innerRequestId = asString(args.requestId);
    if (!isDshClientRequest(send.request) || innerRequestId !== rpcId) {
      throw new Error('dsh prompt send: outer rpcId must equal the inner requestId');
    }
    const sessionId = asString(args.sessionId);
    if (!sessionId) throw new Error('dsh prompt send: sessionId must be a non-empty string');
    pending.set(rpcId, {
      sessionId,
      requestId: rpcId,
      bound: false,
      faded: false,
      diff: openTurns.get(sessionId) ? 'pending' : 'idle',
    });
  }

  function bindUserMessage(op: Extract<DshNormalizeOp, { kind: 'user-message' }>): DshPromptEntryEffect[] {
    // Injections are not prompt answers; an unknown rpcId is not ours.
    if (op.sourceKind === 'injection' || !op.rpcId) return [];
    const card = pending.get(op.rpcId);
    if (!card || card.bound) return [];
    if (op.sessionId && op.sessionId !== card.sessionId) return [];
    if (cardsByRoot.has(op.messageId)) return [];
    card.rootMessageId = op.messageId;
    card.bound = true;
    pending.delete(card.requestId);
    cardsByRoot.set(op.messageId, card);
    activeBySession.set(card.sessionId, card);
    return [{ kind: 'card-bound', sessionId: card.sessionId, requestId: card.requestId, cardId: op.messageId }];
  }

  function associateReply(op: Extract<DshNormalizeOp, { kind: 'message' }>): DshPromptEntryEffect[] {
    if (op.message.role !== 'assistant') return [];
    const card = activeBySession.get(op.message.sessionID);
    if (!card?.rootMessageId) return [];
    const key = `${card.sessionId}:${op.message.id}`;
    if (seenReplies.has(key)) return [];
    seenReplies.add(key);
    if (card.faded) {
      return [{ kind: 'card-refresh', sessionId: card.sessionId, cardId: card.rootMessageId, replyId: op.message.id }];
    }
    card.faded = true;
    return [{ kind: 'reply-fade-in', sessionId: card.sessionId, cardId: card.rootMessageId, replyId: op.message.id }];
  }

  function applyTurn(op: Extract<DshNormalizeOp, { kind: 'turn' }>): DshPromptEntryEffect[] {
    const card = activeBySession.get(op.sessionId);
    if (op.phase === 'started') {
      openTurns.set(op.sessionId, true);
      if (card) card.diff = 'pending';
      return [];
    }
    openTurns.set(op.sessionId, false);
    if (!card?.rootMessageId) return [];
    card.diff = 'refreshed';
    return [{ kind: 'diff-refresh', sessionId: op.sessionId, cardId: card.rootMessageId, reason: op.reason?.kind ?? 'completed' }];
  }

  function ingest(result: DshNormalizeResult): DshPromptEntryEffect[] {
    // The normalizer's seq gate already marked replayed/duplicate records.
    if (result.duplicate) return [];
    const effects: DshPromptEntryEffect[] = [];
    for (const op of result.ops) {
      if (op.kind === 'user-message') effects.push(...bindUserMessage(op));
      else if (op.kind === 'message') effects.push(...associateReply(op));
      else if (op.kind === 'turn') effects.push(...applyTurn(op));
    }
    return effects;
  }

  return {
    begin,
    ingest,
    card: (rootMessageId) => {
      const card = cardsByRoot.get(rootMessageId);
      return card ? snapshot(card) : undefined;
    },
    pending: (requestId) => {
      const card = pending.get(requestId);
      return card ? snapshot(card) : undefined;
    },
    cards: () => [...cardsByRoot.values()].map(snapshot),
  };
}
