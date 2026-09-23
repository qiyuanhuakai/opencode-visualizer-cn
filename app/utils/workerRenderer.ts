import RenderWorker from '../workers/render-worker?worker';
import { incrementPendingRenders, decrementPendingRenders } from '../composables/useRenderState';
import { RenderCancelledError } from './renderErrors';
import { ByteWeightedLruCache } from './byteWeightedLru';

export { RenderCancelledError } from './renderErrors';
// Streaming client lives in ./workerStream; re-exported here so the public
// worker-renderer API stays single-entry (additive protocol, D1/D4).
export { startRenderWorkerStream } from './workerStream';
export type {
  RenderWorkerStream,
  StreamBatchCallback,
  StreamOpenParams,
  StreamTokenBatch,
} from './workerStream';

export type RenderRequest = {
  id: string;
  code: string;
  patch?: string;
  after?: string;
  lang: string;
  theme: string;
  gutterMode?: 'none' | 'single' | 'double';
  gutterLines?: string[];
  grepPattern?: string;
  lineOffset?: number;
  lineLimit?: number;
  files?: string[];
  copyButtonLabel?: string;
  copiedLabel?: string;
  copyCodeAriaLabel?: string;
  copyMarkdownAriaLabel?: string;
  copyButtons?: boolean;
  errorLabel?: string;
};

type RenderResponse =
  | { id: string; ok: true; html: string }
  | { id: string; ok: false; error: string };

type PendingEntry = {
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  worker: Worker;
  errorLabel?: string;
  timeoutId: ReturnType<typeof setTimeout>;
};

type RenderTask = {
  promise: Promise<string>;
  cancel: () => void;
};

const RENDER_WORKER_POOL_CEILING = 4;
const RENDER_REQUEST_TIMEOUT_MS = 25_000;
const WORKER_POOL_SIZE =
  typeof navigator !== 'undefined'
    ? Math.min(RENDER_WORKER_POOL_CEILING, Math.max(2, navigator.hardwareConcurrency || 2))
    : RENDER_WORKER_POOL_CEILING;

const workers: Worker[] = [];
let workerIndex = 0;
const pending = new Map<string, PendingEntry>();
let nextCollisionId = 0;
const completedCache = new ByteWeightedLruCache<string, string>({
  maxBytes: 16 * 1024 * 1024,
  weigh: (key, html) => (key.length + html.length) * 2,
});

function normalizeLines(value?: string[]) {
  return value && value.length > 0 ? value.join('\u0001') : '';
}

function normalizeFiles(value?: string[]) {
  return value && value.length > 0 ? value.join('\u0001') : '';
}

function getCacheKey(payload: RenderRequest) {
  return [
    payload.code,
    payload.patch ?? '',
    payload.after ?? '',
    payload.lang,
    payload.theme,
    payload.gutterMode ?? '',
    normalizeLines(payload.gutterLines),
    payload.grepPattern ?? '',
    String(payload.lineOffset ?? ''),
    String(payload.lineLimit ?? ''),
    normalizeFiles(payload.files),
    payload.copyButtonLabel ?? '',
    payload.copiedLabel ?? '',
    payload.copyCodeAriaLabel ?? '',
    payload.copyMarkdownAriaLabel ?? '',
    String(payload.copyButtons ?? true),
  ].join('\u0000');
}

function cacheRenderedHtml(key: string, html: string) {
  completedCache.set(key, html);
}

function errorFromWorkerEvent(error: unknown): Error {
  if (error instanceof Error) return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return new Error(error.message);
  }
  return new Error(String(error));
}

function createWorker(slotIndex: number): Worker {
  const worker = new RenderWorker();
  worker.onmessage = (event: MessageEvent<RenderResponse>) => {
    const data = event.data;
    const entry = pending.get(data.id);
    if (!entry || entry.worker !== worker) return;
    pending.delete(data.id);
    clearTimeout(entry.timeoutId);
    decrementPendingRenders();
    if (data.ok) entry.resolve(data.html);
    else entry.reject(new Error(data.error || entry.errorLabel || 'Render failed'));
  };
  worker.onerror = (error) => {
    failWorker(slotIndex, worker, errorFromWorkerEvent(error));
  };
  return worker;
}

function failWorker(slotIndex: number, worker: Worker, error: Error) {
  if (workers[slotIndex] !== worker) return;
  for (const [requestId, entry] of pending) {
    if (entry.worker !== worker) continue;
    pending.delete(requestId);
    clearTimeout(entry.timeoutId);
    entry.reject(error);
    decrementPendingRenders();
  }
  workers[slotIndex] = createWorker(slotIndex);
  worker.terminate();
}

function requestTimeout(id: string, worker: Worker) {
  return setTimeout(() => {
    if (pending.get(id)?.worker !== worker) return;
    const slotIndex = workers.indexOf(worker);
    if (slotIndex >= 0) failWorker(slotIndex, worker, new Error('Render worker timed out'));
  }, RENDER_REQUEST_TIMEOUT_MS);
}

function getWorker(): Worker {
  if (workers.length === 0) {
    for (let i = 0; i < WORKER_POOL_SIZE; i++) {
      workers.push(createWorker(i));
    }
  }
  const worker = workers[workerIndex];
  workerIndex = (workerIndex + 1) % workers.length;
  return worker;
}

function uniqueRequestId(requestId: string) {
  if (!pending.has(requestId)) return requestId;
  let id: string;
  do {
    id = `${requestId}:${++nextCollisionId}`;
  } while (pending.has(id));
  return id;
}

export function renderWorkerHtml(payload: RenderRequest) {
  const cacheKey = getCacheKey(payload);
  const cached = completedCache.get(cacheKey);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  const id = uniqueRequestId(payload.id);
  incrementPendingRenders();
  return new Promise<string>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = getWorker();
    } catch (error) {
      decrementPendingRenders();
      reject(errorFromWorkerEvent(error));
      return;
    }
    pending.set(id, {
      resolve: (html) => {
        cacheRenderedHtml(cacheKey, html);
        resolve(html);
      },
      reject,
      worker,
      errorLabel: payload.errorLabel,
      timeoutId: requestTimeout(id, worker),
    });
    try {
      worker.postMessage(id === payload.id ? payload : { ...payload, id });
    } catch (error) {
      const entry = pending.get(id);
      if (entry) {
        pending.delete(id);
        clearTimeout(entry.timeoutId);
        decrementPendingRenders();
        entry.reject(errorFromWorkerEvent(error));
      }
    }
  });
}

export function startRenderWorkerHtml(payload: RenderRequest): RenderTask {
  const cacheKey = getCacheKey(payload);
  const cached = completedCache.get(cacheKey);
  if (cached !== undefined) {
    return {
      promise: Promise.resolve(cached),
      cancel: () => {},
    };
  }

  const id = uniqueRequestId(payload.id);
  let settled = false;
  incrementPendingRenders();

  const promise = new Promise<string>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = getWorker();
    } catch (error) {
      settled = true;
      decrementPendingRenders();
      reject(errorFromWorkerEvent(error));
      return;
    }
    pending.set(id, {
      resolve: (html) => {
        if (settled) return;
        settled = true;
        cacheRenderedHtml(cacheKey, html);
        resolve(html);
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      },
      worker,
      errorLabel: payload.errorLabel,
      timeoutId: requestTimeout(id, worker),
    });
    try {
      worker.postMessage(id === payload.id ? payload : { ...payload, id });
    } catch (error) {
      const entry = pending.get(id);
      if (entry) {
        pending.delete(id);
        clearTimeout(entry.timeoutId);
        decrementPendingRenders();
        entry.reject(errorFromWorkerEvent(error));
      }
    }
  });

  return {
    promise,
    cancel: () => {
      if (settled) return;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timeoutId);
      decrementPendingRenders();
      entry.reject(new RenderCancelledError());
    },
  };
}
