import { describe, expect, it, vi } from 'vitest';
import { StreamSessionManager } from './streamSession';
import {
  createStreamMessageHandler,
  type StreamOpenParams,
  type StreamWorkerRequest,
  type StreamWorkerResponse,
} from './streamHandler';

const THEME = 'github-dark';

function makeParams(overrides?: Partial<StreamOpenParams>): StreamOpenParams {
  return {
    lang: 'typescript',
    theme: THEME,
    gutterMode: 'single',
    gutterLines: ['10', '11'],
    lineOffset: 9,
    lineLimit: 50,
    copyButtonLabel: 'COPY',
    copiedLabel: 'Copied!',
    ...overrides,
  };
}

function openRequest(streamId: string, params: StreamOpenParams): StreamWorkerRequest {
  return { stream: true, op: 'open', id: `${streamId}-open`, streamId, params };
}

function chunkRequest(streamId: string, chunk: string): StreamWorkerRequest {
  return { stream: true, op: 'chunk', id: `${streamId}-chunk-${chunk.length}`, streamId, chunk };
}

function closeRequest(streamId: string): StreamWorkerRequest {
  return { stream: true, op: 'close', id: `${streamId}-close`, streamId };
}

function setup() {
  const manager = new StreamSessionManager();
  const messages: StreamWorkerResponse[] = [];
  const renderFinal = vi.fn((code: string, params: StreamOpenParams) =>
    Promise.resolve(`<final lang="${params.lang}">${code.length}</final>`),
  );
  const handle = createStreamMessageHandler({
    manager,
    renderFinal,
    post: (message) => messages.push(message),
  });
  return { manager, messages, renderFinal, handle };
}

describe('createStreamMessageHandler', () => {
  it('emits tokens messages carrying real recall/stable/unstable batches per chunk', async () => {
    // Given: an opened typescript stream
    const { messages, renderFinal, handle } = setup();
    await handle(openRequest('s1', makeParams()));

    // When: two chunks each completing a line are enqueued
    await handle(chunkRequest('s1', 'const answer: number = 42;\n'));
    await handle(chunkRequest('s1', 'console.log(answer);\n'));

    // Then: one tokens message per chunk, with real token batches
    expect(messages).toHaveLength(2);
    const [first, second] = messages;
    expect(first?.kind).toBe('tokens');
    expect(second?.kind).toBe('tokens');
    if (first?.kind !== 'tokens' || second?.kind !== 'tokens') throw new Error('not tokens');

    expect(first.streamId).toBe('s1');
    expect(typeof first.recall).toBe('number');
    expect(first.stable.length).toBeGreaterThan(0);
    expect(first.stable.some((token) => token.content.includes('const'))).toBe(true);
    expect(Array.isArray(first.unstable)).toBe(true);

    // And: the second batch extends the stream (new stable tokens, no repeat)
    expect(second.stable.length).toBeGreaterThan(0);
    expect(second.stable.some((token) => token.content.includes('console'))).toBe(true);
    expect(second.stable).not.toEqual(first.stable);

    // And: no final render happened yet
    expect(renderFinal).not.toHaveBeenCalled();
  });

  it('on close flushes trailing stable tokens, then renders final html from the full code', async () => {
    // Given: an opened stream with one terminated line and one unterminated line
    const { messages, renderFinal, handle } = setup();
    const params = makeParams();
    await handle(openRequest('s-close', params));
    await handle(chunkRequest('s-close', 'const a = 1;\n'));
    await handle(chunkRequest('s-close', 'const b = 2;'));

    // When: the stream is closed
    await handle(closeRequest('s-close'));

    // Then: a final tokens message flushes the trailing stable tokens before 'final'
    const kinds = messages.map((message) => message.kind);
    expect(kinds).toEqual(['tokens', 'tokens', 'tokens', 'final']);
    const flush = messages[2];
    if (flush?.kind !== 'tokens') throw new Error('flush is not tokens');
    expect(flush.stable.length).toBeGreaterThan(0);
    expect(flush.stable.some((token) => token.content.includes('const'))).toBe(true);
    expect(flush.unstable).toEqual([]);

    // And: the final renderer ran exactly once with the full accumulated code
    // and the exact params captured at open
    expect(renderFinal).toHaveBeenCalledTimes(1);
    expect(renderFinal).toHaveBeenCalledWith('const a = 1;\nconst b = 2;', params);

    // And: the final message carries the renderer's html
    const final = messages[3];
    expect(final?.kind).toBe('final');
    if (final?.kind !== 'final') throw new Error('not final');
    expect(final.streamId).toBe('s-close');
    expect(final.html).toBe('<final lang="typescript">25</final>');
  });

  it('emits an error message for a chunk on an unknown streamId', async () => {
    // Given: no opened streams
    const { messages, handle } = setup();

    // When: a chunk arrives for an unknown streamId
    await handle(chunkRequest('ghost', 'const a = 1;\n'));

    // Then: a single error message naming the streamId
    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message?.kind).toBe('error');
    if (message?.kind !== 'error') throw new Error('not error');
    expect(message.streamId).toBe('ghost');
    expect(message.error).toContain('ghost');
  });

  it('emits an error message for a close on an unknown streamId', async () => {
    // Given: no opened streams
    const { messages, handle } = setup();

    // When: a close arrives for an unknown streamId
    await handle(closeRequest('ghost-close'));

    // Then: a single error message naming the streamId
    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind).toBe('error');
    if (messages[0]?.kind !== 'error') throw new Error('not error');
    expect(messages[0].streamId).toBe('ghost-close');
  });

  it('cancel during open suppresses all subsequent messages for that streamId', async () => {
    // Given: an open request whose async completion races with a cancel
    const { manager, messages, handle } = setup();
    const openDone = handle(openRequest('s-cancel', makeParams()));

    // When: cancel is processed before the open completes
    await handle({ stream: true, op: 'cancel', id: 's-cancel-cancel', streamId: 's-cancel' });
    await openDone;
    await handle(chunkRequest('s-cancel', 'const a = 1;\n'));
    await handle(closeRequest('s-cancel'));

    // Then: the session never materialized and no messages were posted
    expect(manager.has('s-cancel')).toBe(false);
    expect(messages).toEqual([]);
  });

  it('cancel after streaming stops further messages; queued chunks stay silent', async () => {
    // Given: an open stream that already emitted one batch
    const { manager, messages, handle } = setup();
    await handle(openRequest('s-mid', makeParams()));
    await handle(chunkRequest('s-mid', 'const a = 1;\n'));
    expect(messages).toHaveLength(1);

    // When: the stream is cancelled and more ops arrive afterwards
    await handle({ stream: true, op: 'cancel', id: 's-mid-cancel', streamId: 's-mid' });
    await handle(chunkRequest('s-mid', 'const b = 2;\n'));
    await handle(closeRequest('s-mid'));

    // Then: the session is gone and no further messages were posted
    expect(manager.has('s-mid')).toBe(false);
    expect(messages).toHaveLength(1);
  });

  describe('bookkeeping cleanup (long-lived worker)', () => {
    // Bookkeeping entries are pruned on a macrotask after the stream's op
    // chain settles, so tests flush one timer turn before asserting.
    const flushPrune = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('frees all bookkeeping for a streamId after close completes and its chain settles', async () => {
      // Given: a stream that opened, streamed, and closed cleanly
      const { handle } = setup();
      await handle(openRequest('s-free', makeParams()));
      await handle(chunkRequest('s-free', 'const a = 1;\n'));
      await handle(closeRequest('s-free'));

      // When: the post-settle prune turn runs
      await flushPrune();

      // Then: no states/chains/cancelled entries remain for the streamId
      expect(handle._debugState()).toEqual({ states: 0, chains: 0, cancelled: 0 });
    });

    it('frees all bookkeeping for a streamId after cancel once queued work settles', async () => {
      // Given: an open stream cancelled mid-flight
      const { handle } = setup();
      await handle(openRequest('s-cfree', makeParams()));
      await handle(chunkRequest('s-cfree', 'const a = 1;\n'));
      await handle({ stream: true, op: 'cancel', id: 's-cfree-cancel', streamId: 's-cfree' });

      // When: the queued chain has settled and the prune turn runs
      await flushPrune();

      // Then: the cancelled tombstone and chain entry are gone
      expect(handle._debugState()).toEqual({ states: 0, chains: 0, cancelled: 0 });
    });

    it('cancel followed by reopen with the same id still streams and finalizes', async () => {
      // Given: a cancelled stream whose bookkeeping was pruned
      const { messages, handle } = setup();
      await handle(openRequest('s-re', makeParams()));
      await handle({ stream: true, op: 'cancel', id: 's-re-cancel', streamId: 's-re' });
      await flushPrune();
      expect(handle._debugState()).toEqual({ states: 0, chains: 0, cancelled: 0 });
      messages.length = 0;

      // When: the same id is reopened and driven to close
      await handle(openRequest('s-re', makeParams()));
      await handle(chunkRequest('s-re', 'const a = 1;\n'));
      await handle(closeRequest('s-re'));

      // Then: tokens and final html flow normally for the revived id
      expect(messages.map((message) => message.kind)).toEqual(['tokens', 'final']);

      // And: bookkeeping is freed again after this close settles
      await flushPrune();
      expect(handle._debugState()).toEqual({ states: 0, chains: 0, cancelled: 0 });
    });
  });
});
