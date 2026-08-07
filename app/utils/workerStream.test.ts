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
    crash(error: unknown) {
      this.onerror?.(error);
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

function onlyWorker(): FakeWorker {
  const worker = workerState.FakeWorker.instances[0];
  if (!worker) throw new Error('no dedicated stream worker');
  return worker;
}

beforeEach(() => {
  vi.resetModules();
  workerState.FakeWorker.instances = [];
});

describe('startRenderWorkerStream teardown', () => {
  it('tears down the stream entry when the worker reports an error (late messages ignored, ops inert)', async () => {
    // Given: an open stream with a pending close and a batch listener
    const mod = await import('./workerStream');
    const stream = mod.startRenderWorkerStream({ lang: 'typescript', theme: 'github-dark' });
    const streamWorker = onlyWorker();
    const streamId = streamIdOf(streamWorker.posted[0]);
    const batches: unknown[] = [];
    stream.onBatch((batch) => batches.push(batch));
    const closePromise = stream.close();
    const rejection = expect(closePromise).rejects.toThrow('boom: broken tokenizer');

    // When: the worker reports an error for the stream
    streamWorker.emit({ kind: 'error', id: 'm1', streamId, error: 'boom: broken tokenizer' });
    await rejection;

    // Then: the entry is torn down — late worker messages for the stream are ignored
    streamWorker.emit({
      kind: 'tokens',
      id: 'm2',
      streamId,
      recall: 0,
      stable: [{ content: 'const' }],
      unstable: [],
    });
    expect(batches).toEqual([]);

    // And: sendChunk no longer posts to the worker
    const postedCount = streamWorker.posted.length;
    stream.sendChunk('const late = true;');
    expect(streamWorker.posted).toHaveLength(postedCount);

    // And: cancel() is a no-op (no cancel request posted for the dead stream)
    stream.cancel();
    expect(streamWorker.posted).toHaveLength(postedCount);
  });

  it('rejects close() immediately without posting when the worker already reported an error', async () => {
    // Given: an open stream whose worker reports an error before any close
    const mod = await import('./workerStream');
    const stream = mod.startRenderWorkerStream({ lang: 'typescript', theme: 'github-dark' });
    const streamWorker = onlyWorker();
    const streamId = streamIdOf(streamWorker.posted[0]);
    streamWorker.emit({ kind: 'error', id: 'm1', streamId, error: 'boom' });

    // When: close() is called on the dead stream
    const postedCount = streamWorker.posted.length;
    const closePromise = stream.close();

    // Then: it rejects immediately without posting a close request
    const { RenderCancelledError } = await import('./renderErrors');
    expect(streamWorker.posted).toHaveLength(postedCount);
    await expect(closePromise).rejects.toBeInstanceOf(RenderCancelledError);
  });

  it('rejects pending close and marks streams done on fatal worker error; later ops stay inert', async () => {
    // Given: two open streams on the shared stream worker, one with a pending close
    const mod = await import('./workerStream');
    const streamA = mod.startRenderWorkerStream({ lang: 'typescript', theme: 'github-dark' });
    const streamB = mod.startRenderWorkerStream({ lang: 'typescript', theme: 'github-dark' });
    expect(workerState.FakeWorker.instances).toHaveLength(1);
    const streamWorker = onlyWorker();
    const closeA = streamA.close();
    const rejectionA = expect(closeA).rejects.toThrow('worker exploded');

    // When: the worker dies with a fatal error
    streamWorker.crash(new Error('worker exploded'));
    await rejectionA;

    // Then: close() on the other dead stream rejects immediately without posting
    const { RenderCancelledError } = await import('./renderErrors');
    const postedCount = streamWorker.posted.length;
    const closeB = streamB.close();
    expect(streamWorker.posted).toHaveLength(postedCount);
    await expect(closeB).rejects.toBeInstanceOf(RenderCancelledError);

    // And: sendChunk and cancel stay inert on the dead stream
    streamB.sendChunk('const late = true;');
    streamB.cancel();
    expect(streamWorker.posted).toHaveLength(postedCount);
  });
});
