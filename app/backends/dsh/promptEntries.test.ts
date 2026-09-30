import { describe, expect, it } from 'vitest';

import {
  createDshPromptEntries,
  createDshPromptSend,
  type DshPromptSend,
} from './promptEntries';
import type { DshNormalizeOp, DshNormalizeResult } from './ops';
import { isDshClientRequest, type DshClientRequest } from './types';

// ---------------------------------------------------------------------------
// Builders. The wire evidence (docs/dsh.md §9 / 04-session-follow-full.txt) is
// the source of truth: `agent/inbox/spliced` and `user/message` both carry
// `source:{kind:'user',rpcId}` whose rpcId echoes the prompt envelope's rpcId.
// ---------------------------------------------------------------------------

const SESSION = 'session-06ee930d-7d74-42b1-928d-ac8fdd4376bf';

function prompt(sessionId = SESSION) {
  return createDshPromptSend(
    { sessionId, content: [{ type: 'text', text: 'say hi' }] },
    () => 'req-1',
  );
}

function result(sessionId: string, ops: DshNormalizeOp[], duplicate = false): DshNormalizeResult {
  return { eventType: 'test', sessionId, duplicate, duplicateCount: duplicate ? 1 : 0, ops };
}

function userOp(sessionId: string, messageId: string, rpcId: string, sourceKind = 'user'): DshNormalizeOp {
  return { kind: 'user-message', sessionId, messageId, sourceKind, rpcId, role: 'user', time: 1 };
}

function assistantOp(id: string, sessionId = SESSION): DshNormalizeOp {
  // Only identity + role are read by the tracker; the rest of MessageInfo is
  // irrelevant to prompt binding, so a structural cast keeps the fixture lean.
  return {
    kind: 'message',
    message: { id, sessionID: sessionId, role: 'assistant' } as never,
  };
}

function turnOp(phase: 'started' | 'ended', sessionId = SESSION, turn = 1): DshNormalizeOp {
  return phase === 'started'
    ? { kind: 'turn', phase, sessionId, turn, time: 1 }
    : { kind: 'turn', phase, sessionId, turn, time: 2, reason: { kind: 'completed' } };
}

describe('createDshPromptSend', () => {
  it('uses the generated requestId as BOTH the inner requestId and the outer envelope rpcId', () => {
    const send = prompt();
    expect(send.requestId).toBe('req-1');
    expect(send.request.rpcId).toBe('req-1');
    expect(send.request.payload.args.requestId).toBe('req-1');
    expect(send.request.type).toBe('client-request');
    expect(send.request.method).toBe('session/prompt');
    expect(send.request.payload.args.sessionId).toBe(SESSION);
    expect(send.request.payload.args.mode).toBe('queue');
    expect(isDshClientRequest(send.request)).toBe(true);
  });

  it('defaults to crypto.randomUUID and keeps rpcId === requestId for every send', () => {
    const first = createDshPromptSend({ sessionId: SESSION, content: [{ type: 'text', text: 'a' }] });
    const second = createDshPromptSend({ sessionId: SESSION, content: [{ type: 'text', text: 'b' }] });
    expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.request.rpcId).toBe(first.requestId);
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.request.payload.args.requestId).toBe(second.requestId);
  });
});

describe('createDshPromptEntries', () => {
  it('binds the followed user message by outer rpcId and adopts the SERVER message id as the card', () => {
    const entries = createDshPromptEntries();
    const send = prompt();
    entries.begin(send);

    expect(entries.pending('req-1')?.bound).toBe(false);
    expect(entries.pending('req-1')?.rootMessageId).toBeUndefined();

    const effects = entries.ingest(result(SESSION, [userOp(SESSION, 'server-u1', 'req-1')]));

    expect(effects).toEqual([
      { kind: 'card-bound', sessionId: SESSION, requestId: 'req-1', cardId: 'server-u1' },
    ]);
    const card = entries.card('server-u1');
    expect(card?.requestId).toBe('req-1');
    expect(card?.rootMessageId).toBe('server-u1');
    expect(card?.bound).toBe(true);
    // The local requestId is never a message/card identity.
    expect(entries.card('req-1')).toBeUndefined();
    expect(entries.pending('req-1')).toBeUndefined();
  });

  it('rejects a send whose inner requestId diverges from the outer rpcId', () => {
    const entries = createDshPromptEntries();
    const broken = {
      requestId: 'req-x',
      request: {
        type: 'client-request',
        rpcId: 'req-x',
        method: 'session/prompt',
        payload: { args: { requestId: 'other', sessionId: SESSION, mode: 'queue', content: [] } },
      } as DshClientRequest,
    } satisfies DshPromptSend;
    expect(() => entries.begin(broken)).toThrow();
  });

  it('ignores a user message whose rpcId matches no pending prompt, and never binds an injection', () => {
    const entries = createDshPromptEntries();
    entries.begin(prompt());

    expect(entries.ingest(result(SESSION, [userOp(SESSION, 'stray', 'req-unknown')]))).toEqual([]);
    expect(entries.ingest(result(SESSION, [userOp(SESSION, 'injected', 'req-1', 'injection')]))).toEqual([]);
    expect(entries.card('stray')).toBeUndefined();
    expect(entries.pending('req-1')?.bound).toBe(false);
  });

  it('fades in ONLY the first reply, refreshes the same card afterwards, and dedups repeats', () => {
    const entries = createDshPromptEntries();
    entries.begin(prompt());
    entries.ingest(result(SESSION, [userOp(SESSION, 'server-u1', 'req-1')]));

    expect(entries.ingest(result(SESSION, [assistantOp('a1')]))).toEqual([
      { kind: 'reply-fade-in', sessionId: SESSION, cardId: 'server-u1', replyId: 'a1' },
    ]);
    expect(entries.card('server-u1')?.faded).toBe(true);

    // A later distinct reply refreshes the SAME card without fading again.
    expect(entries.ingest(result(SESSION, [assistantOp('a2')]))).toEqual([
      { kind: 'card-refresh', sessionId: SESSION, cardId: 'server-u1', replyId: 'a2' },
    ]);

    // A duplicate reply id does not re-enter the list (id dedup).
    expect(entries.ingest(result(SESSION, [assistantOp('a1')]))).toEqual([]);

    // A record the normalizer already marked duplicate is dropped (seq dedup).
    expect(entries.ingest(result(SESSION, [assistantOp('a3')], true))).toEqual([]);

    // Card identity stays in place: one card, same root message.
    expect(entries.cards()).toHaveLength(1);
    expect(entries.card('server-u1')?.rootMessageId).toBe('server-u1');
    expect(entries.card('server-u1')?.faded).toBe(true);
  });

  it('refreshes the card diff state when the turn completes', () => {
    const entries = createDshPromptEntries();
    entries.begin(prompt());
    entries.ingest(result(SESSION, [userOp(SESSION, 'server-u1', 'req-1')]));

    expect(entries.card('server-u1')?.diff).toBe('idle');
    entries.ingest(result(SESSION, [turnOp('started')]));
    expect(entries.card('server-u1')?.diff).toBe('pending');

    expect(entries.ingest(result(SESSION, [turnOp('ended')]))).toEqual([
      { kind: 'diff-refresh', sessionId: SESSION, cardId: 'server-u1', reason: 'completed' },
    ]);
    expect(entries.card('server-u1')?.diff).toBe('refreshed');
  });

  it('keeps two queued prompts in one session from cross-matching', () => {
    const entries = createDshPromptEntries();
    const a = createDshPromptSend({ sessionId: SESSION, content: [{ type: 'text', text: 'A' }] }, () => 'req-A');
    const b = createDshPromptSend({ sessionId: SESSION, content: [{ type: 'text', text: 'B' }] }, () => 'req-B');
    entries.begin(a);
    entries.begin(b);

    const aEffects = entries.ingest(result(SESSION, [
      userOp(SESSION, 'u-A', 'req-A'),
      assistantOp('a-A'),
      turnOp('ended', SESSION, 1),
    ]));
    const bEffects = entries.ingest(result(SESSION, [
      userOp(SESSION, 'u-B', 'req-B'),
      assistantOp('a-B'),
      turnOp('ended', SESSION, 2),
    ]));

    expect(aEffects).toEqual([
      { kind: 'card-bound', sessionId: SESSION, requestId: 'req-A', cardId: 'u-A' },
      { kind: 'reply-fade-in', sessionId: SESSION, cardId: 'u-A', replyId: 'a-A' },
      { kind: 'diff-refresh', sessionId: SESSION, cardId: 'u-A', reason: 'completed' },
    ]);
    expect(bEffects).toEqual([
      { kind: 'card-bound', sessionId: SESSION, requestId: 'req-B', cardId: 'u-B' },
      { kind: 'reply-fade-in', sessionId: SESSION, cardId: 'u-B', replyId: 'a-B' },
      { kind: 'diff-refresh', sessionId: SESSION, cardId: 'u-B', reason: 'completed' },
    ]);
    expect(entries.card('u-A')?.requestId).toBe('req-A');
    expect(entries.card('u-B')?.requestId).toBe('req-B');
  });

  it('does not associate a reply that arrives before any card is bound', () => {
    const entries = createDshPromptEntries();
    entries.begin(prompt());
    expect(entries.ingest(result(SESSION, [assistantOp('early')]))).toEqual([]);
    expect(entries.cards()).toHaveLength(0);
  });
});
