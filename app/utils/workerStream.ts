import RenderWorker from '../workers/render-worker?worker';
import { RenderCancelledError } from './renderErrors';
import type {
  StreamOpenParams,
  StreamTokenBatch,
  StreamWorkerRequest,
  StreamWorkerResponse,
} from '../workers/streamHandler';

export type { StreamOpenParams, StreamTokenBatch } from '../workers/streamHandler';

export type StreamBatchCallback = (batch: StreamTokenBatch) => void;

export type RenderWorkerStream = {
  sendChunk: (chunk: string) => void;
  close: () => Promise<string>;
  cancel: () => void;
  onBatch: (callback: StreamBatchCallback) => void;
};

type StreamEntry = {
  batchCallbacks: StreamBatchCallback[];
  settleClose: { resolve: (html: string) => void; reject: (error: Error) => void } | null;
  done: boolean;
};

let streamWorker: Worker | null = null;
const streamEntries = new Map<string, StreamEntry>();
let streamCounter = 0;

function createStreamWorker(): Worker {
  const worker = new RenderWorker();
  worker.onmessage = (event: MessageEvent<StreamWorkerResponse>) => {
    const data = event.data;
    const entry = streamEntries.get(data.streamId);
    if (!entry) return;
    switch (data.kind) {
      case 'tokens':
        for (const callback of entry.batchCallbacks) {
          callback({ recall: data.recall, stable: data.stable, unstable: data.unstable });
        }
        break;
      case 'final':
        entry.done = true;
        streamEntries.delete(data.streamId);
        entry.settleClose?.resolve(data.html);
        break;
      case 'error':
        entry.done = true;
        streamEntries.delete(data.streamId);
        entry.settleClose?.reject(new Error(data.error));
        entry.settleClose = null;
        break;
    }
  };
  worker.onerror = (error) => {
    streamEntries.forEach((entry) => {
      entry.done = true;
      entry.settleClose?.reject(new Error(String(error)));
      entry.settleClose = null;
    });
    streamEntries.clear();
    streamWorker = null;
  };
  return worker;
}

function getStreamWorker(): Worker {
  streamWorker ??= createStreamWorker();
  return streamWorker;
}

/**
 * Opens a streaming highlight session on a lazily created dedicated worker
 * (separate from the single-shot round-robin pool; tokenizer state never
 * migrates). Batch callbacks fire in arrival order. close() resolves with the
 * converged final HTML — identical to the equivalent single-shot render — and
 * rejects if the worker reports an error for the stream. cancel() posts a
 * cancel request, rejects any pending close() with RenderCancelledError, and
 * invalidates the stream: later worker messages for it are ignored.
 */
export function startRenderWorkerStream(params: StreamOpenParams): RenderWorkerStream {
  const worker = getStreamWorker();
  streamCounter += 1;
  const streamId = `stream-${streamCounter}`;
  let requestCounter = 0;
  const nextRequestId = () => `${streamId}-${(requestCounter += 1)}`;
  const entry: StreamEntry = { batchCallbacks: [], settleClose: null, done: false };
  streamEntries.set(streamId, entry);

  const send = (request: StreamWorkerRequest) => worker.postMessage(request);
  send({ stream: true, op: 'open', id: nextRequestId(), streamId, params });

  let closePromise: Promise<string> | null = null;

  return {
    sendChunk(chunk) {
      if (entry.done) return;
      send({ stream: true, op: 'chunk', id: nextRequestId(), streamId, chunk });
    },
    close() {
      closePromise ??= new Promise<string>((resolve, reject) => {
        if (entry.done) {
          reject(new RenderCancelledError());
          return;
        }
        entry.settleClose = { resolve, reject };
        send({ stream: true, op: 'close', id: nextRequestId(), streamId });
      });
      return closePromise;
    },
    cancel() {
      if (entry.done) return;
      entry.done = true;
      send({ stream: true, op: 'cancel', id: nextRequestId(), streamId });
      streamEntries.delete(streamId);
      entry.settleClose?.reject(new RenderCancelledError());
      entry.settleClose = null;
    },
    onBatch(callback) {
      entry.batchCallbacks.push(callback);
    },
  };
}
