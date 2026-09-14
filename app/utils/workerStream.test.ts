import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  onlyTestRenderWorker,
  resetTestRenderWorkers,
  streamIdOf,
  TestRenderWorker,
} from './workerTransport.test-helpers';

vi.mock('../workers/render-worker?worker', () => ({ default: TestRenderWorker }));

beforeEach(() => {
  vi.resetModules();
  resetTestRenderWorkers();
});

describe('startRenderWorkerStream teardown', () => {
  it('tears down the stream entry when the worker reports an error (late messages ignored, ops inert)', async () => {
    // Given: an open stream with a pending close and a batch listener
    const mod = await import('./workerStream');
    const stream = mod.startRenderWorkerStream({ lang: 'typescript', theme: 'github-dark' });
    const streamWorker = onlyTestRenderWorker();
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
    const streamWorker = onlyTestRenderWorker();
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
    expect(TestRenderWorker.instances).toHaveLength(1);
    const streamWorker = onlyTestRenderWorker();
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
