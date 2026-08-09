import { beforeEach, describe, expect, it, vi } from 'vitest';

const workerState = vi.hoisted(() => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((error: unknown) => void) | null = null;
    posted: unknown[] = [];
    constructor() {
      FakeWorker.instances.push(this);
    }
    postMessage(message: unknown) {
      this.posted.push(message);
    }
    emit(data: unknown) {
      this.onmessage?.({ data });
    }
  }
  return { FakeWorker };
});

vi.mock('../workers/render-worker?worker', () => ({ default: workerState.FakeWorker }));

type FakeWorker = InstanceType<typeof workerState.FakeWorker>;

function streamIdOf(message: unknown): string {
  if (
    typeof message === 'object' &&
    message !== null &&
    'streamId' in message &&
    typeof message.streamId === 'string'
  ) {
    return message.streamId;
  }
  throw new Error('message has no streamId');
}

function postedStreamMessages(worker: FakeWorker): unknown[] {
  return worker.posted.filter(
    (message) => typeof message === 'object' && message !== null && 'stream' in message,
  );
}

beforeEach(() => {
  vi.resetModules();
  workerState.FakeWorker.instances = [];
});

describe('startRenderWorkerStream', () => {
  it('routes stream traffic to a dedicated worker, delivers batches in order, resolves close with final html', async () => {
    // Given: the single-shot pool already exists (one render in flight)
    const mod = await import('../utils/workerRenderer');
    const singleShot = mod.renderWorkerHtml({
      id: 'single-1',
      code: 'const x = 1;',
      lang: 'typescript',
      theme: 'github-dark',
    });
    const poolSize = workerState.FakeWorker.instances.length;
    expect(poolSize).toBeGreaterThan(0);
    workerState.FakeWorker.instances[0]?.emit({ id: 'single-1', ok: true, html: '<b>x</b>' });
    await expect(singleShot).resolves.toBe('<b>x</b>');

    // When: a stream is opened
    const stream = mod.startRenderWorkerStream({
      lang: 'typescript',
      theme: 'github-dark',
      gutterMode: 'single',
      lineOffset: 3,
    });

    // Then: exactly one new dedicated worker was created, separate from the pool
    expect(workerState.FakeWorker.instances).toHaveLength(poolSize + 1);
    const streamWorker = workerState.FakeWorker.instances[poolSize];
    if (!streamWorker) throw new Error('no dedicated stream worker');
    const openMessage = streamWorker.posted[0];
    expect(openMessage).toMatchObject({
      stream: true,
      op: 'open',
      params: { lang: 'typescript', theme: 'github-dark', gutterMode: 'single', lineOffset: 3 },
    });
    const streamId = streamIdOf(openMessage);

    // And: no pool worker received any stream message
    for (const poolWorker of workerState.FakeWorker.instances.slice(0, poolSize)) {
      expect(postedStreamMessages(poolWorker)).toEqual([]);
    }

    // When: chunks are sent
    stream.sendChunk('const a = 1;\n');
    stream.sendChunk('const b = 2;\n');
    const chunkMessages = streamWorker.posted.slice(1);
    expect(chunkMessages[0]).toMatchObject({
      stream: true,
      op: 'chunk',
      streamId,
      chunk: 'const a = 1;\n',
    });
    expect(chunkMessages[1]).toMatchObject({
      stream: true,
      op: 'chunk',
      streamId,
      chunk: 'const b = 2;\n',
    });

    // Then: token batches arrive at onBatch callbacks in arrival order
    const batches: Array<{ recall: number; stable: unknown[]; unstable: unknown[] }> = [];
    stream.onBatch((batch) => batches.push(batch));
    streamWorker.emit({ kind: 'tokens', id: 'm1', streamId, recall: 0, stable: [{ content: 'const' }], unstable: [] });
    streamWorker.emit({ kind: 'tokens', id: 'm2', streamId, recall: 2, stable: [{ content: 'b' }], unstable: [{ content: ';' }] });
    expect(batches.map((batch) => batch.recall)).toEqual([0, 2]);
    expect(batches[1]?.unstable).toEqual([{ content: ';' }]);

    // And: close() sends the close request and resolves with the final html
    const closePromise = stream.close();
    expect(streamWorker.posted.at(-1)).toMatchObject({ stream: true, op: 'close', streamId });
    streamWorker.emit({ kind: 'final', id: 'm3', streamId, html: '<final-html>' });
    await expect(closePromise).resolves.toBe('<final-html>');
  });

  it('rejects close() when the worker responds with an error message', async () => {
    // Given: an open stream
    const mod = await import('../utils/workerRenderer');
    const stream = mod.startRenderWorkerStream({ lang: 'typescript', theme: 'github-dark' });
    const streamWorker = workerState.FakeWorker.instances[0];
    if (!streamWorker) throw new Error('no dedicated stream worker');
    const streamId = streamIdOf(streamWorker.posted[0]);

    // When: close is requested and the worker reports an error for the stream
    const closePromise = stream.close();
    const rejection = expect(closePromise).rejects.toThrow('boom: broken tokenizer');
    streamWorker.emit({ kind: 'error', id: 'm1', streamId, error: 'boom: broken tokenizer' });

    // Then: close rejects with the worker's error message
    await rejection;
  });

  it('cancel() sends a cancel request and rejects a pending close with RenderCancelledError', async () => {
    // Given: an open stream with a pending close
    const mod = await import('../utils/workerRenderer');
    const stream = mod.startRenderWorkerStream({ lang: 'typescript', theme: 'github-dark' });
    const streamWorker = workerState.FakeWorker.instances[0];
    if (!streamWorker) throw new Error('no dedicated stream worker');
    const streamId = streamIdOf(streamWorker.posted[0]);
    const closePromise = stream.close();

    // When: the stream is cancelled
    stream.cancel();
    const rejection = expect(closePromise).rejects.toBeInstanceOf(mod.RenderCancelledError);

    // Then: a cancel request was posted for the stream
    expect(streamWorker.posted.at(-1)).toMatchObject({ stream: true, op: 'cancel', streamId });
    await rejection;

    // And: late worker messages for the cancelled stream are ignored
    streamWorker.emit({ kind: 'tokens', id: 'm9', streamId, recall: 0, stable: [], unstable: [] });
    streamWorker.emit({ kind: 'final', id: 'm10', streamId, html: '<late/>' });

    // And: a second cancel is a no-op (no extra cancel request)
    const postedCount = streamWorker.posted.length;
    stream.cancel();
    expect(streamWorker.posted).toHaveLength(postedCount);
  });
});

describe('single-shot regression', () => {
  it('renderWorkerHtml resolves pool html and serves repeats from completedCache', async () => {
    // Given: the module with a fresh pool
    const mod = await import('../utils/workerRenderer');
    const request = {
      id: 'cache-1',
      code: 'const cached = true;',
      lang: 'typescript',
      theme: 'github-dark',
    };

    // When: a single-shot render is requested
    const first = mod.renderWorkerHtml(request);
    const poolWorker = workerState.FakeWorker.instances[0];
    if (!poolWorker) throw new Error('no pool worker');
    expect(poolWorker.posted).toEqual([request]);
    poolWorker.emit({ id: 'cache-1', ok: true, html: '<cached-html>' });

    // Then: it resolves with the worker html
    await expect(first).resolves.toBe('<cached-html>');

    // And: an identical request is served from the completedCache without
    // posting to any worker
    const second = mod.renderWorkerHtml({ ...request });
    await expect(second).resolves.toBe('<cached-html>');
    expect(poolWorker.posted).toHaveLength(1);
  });

  it('separates cached Markdown renders with and without copy controls', async () => {
    const mod = await import('../utils/workerRenderer');
    const request = {
      id: 'copy-controls-on',
      code: '# Result',
      lang: 'markdown',
      theme: 'github-dark',
    };

    const withControls = mod.renderWorkerHtml(request);
    const poolWorker = workerState.FakeWorker.instances[0];
    if (!poolWorker) throw new Error('no pool worker');
    poolWorker.emit({ id: request.id, ok: true, html: '<button>COPY</button>' });
    await expect(withControls).resolves.toBe('<button>COPY</button>');

    const withoutControls = mod.renderWorkerHtml({
      ...request,
      id: 'copy-controls-off',
      copyButtons: false,
    });
    const posted = workerState.FakeWorker.instances.flatMap((worker) => worker.posted);
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatchObject({ copyButtons: false });
    const secondWorker = workerState.FakeWorker.instances.find((worker) =>
      worker.posted.some(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'id' in message &&
          message.id === 'copy-controls-off',
      ),
    );
    if (!secondWorker) throw new Error('copy-controls-off request was not posted');
    secondWorker.emit({ id: 'copy-controls-off', ok: true, html: '<h1>Result</h1>' });
    await expect(withoutControls).resolves.toBe('<h1>Result</h1>');
  });

  it('renderWorkerHtml rejects when the pool worker reports an error', async () => {
    // Given: a single-shot request in flight
    const mod = await import('../utils/workerRenderer');
    const failure = mod.renderWorkerHtml({
      id: 'fail-1',
      code: 'broken',
      lang: 'typescript',
      theme: 'github-dark',
    });
    const poolWorker = workerState.FakeWorker.instances[0];
    if (!poolWorker) throw new Error('no pool worker');

    // When: the worker responds with an error
    const rejection = expect(failure).rejects.toThrow('highlight exploded');
    poolWorker.emit({ id: 'fail-1', ok: false, error: 'highlight exploded' });

    // Then: the promise rejects with that error
    await rejection;
  });
});
