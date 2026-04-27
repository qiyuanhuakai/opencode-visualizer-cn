import RenderWorker from '../workers/render-worker?worker';
import { incrementPendingRenders, decrementPendingRenders } from '../composables/useRenderState';

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
  errorLabel?: string;
};

type RenderResponse =
  | { id: string; ok: true; html: string }
  | { id: string; ok: false; error: string };

type PendingEntry = {
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  errorLabel?: string;
};

export class RenderCancelledError extends Error {
  constructor() {
    super('Render request cancelled');
    this.name = 'RenderCancelledError';
  }
}

type RenderTask = {
  promise: Promise<string>;
  cancel: () => void;
};

const WORKER_POOL_SIZE = typeof navigator !== 'undefined'
  ? Math.min(8, Math.max(4, navigator.hardwareConcurrency || 4))
  : 4;

const workers: Worker[] = [];
let workerIndex = 0;
const pending = new Map<string, PendingEntry>();
const completedCache = new Map<string, string>();
const CACHE_LIMIT = 200;

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
  ].join('\u0000');
}

function cacheRenderedHtml(key: string, html: string) {
  if (completedCache.has(key)) {
    completedCache.delete(key);
  }
  completedCache.set(key, html);
  if (completedCache.size <= CACHE_LIMIT) return;
  const oldestKey = completedCache.keys().next().value;
  if (oldestKey) completedCache.delete(oldestKey);
}

function createWorker(): Worker {
  const worker = new RenderWorker();
  worker.onmessage = (event: MessageEvent<RenderResponse>) => {
    const data = event.data;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    decrementPendingRenders();
    if (data.ok) entry.resolve(data.html);
    else entry.reject(new Error(data.error || entry.errorLabel || 'Render failed'));
  };
  worker.onerror = (error) => {
    const count = pending.size;
    pending.forEach((entry) => entry.reject(new Error(String(error))));
    pending.clear();
    for (let i = 0; i < count; i++) {
      decrementPendingRenders();
    }
  };
  return worker;
}

function getWorker(): Worker {
  if (workers.length === 0) {
    for (let i = 0; i < WORKER_POOL_SIZE; i++) {
      workers.push(createWorker());
    }
  }
  const worker = workers[workerIndex];
  workerIndex = (workerIndex + 1) % workers.length;
  return worker;
}

export function renderWorkerHtml(payload: RenderRequest) {
  const cacheKey = getCacheKey(payload);
  const cached = completedCache.get(cacheKey);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  const id = payload.id;
  incrementPendingRenders();
  return new Promise<string>((resolve, reject) => {
    pending.set(id, {
      resolve: (html) => {
        cacheRenderedHtml(cacheKey, html);
        resolve(html);
      },
      reject,
      errorLabel: payload.errorLabel,
    });
    getWorker().postMessage(payload);
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

  const id = payload.id;
  let settled = false;
  incrementPendingRenders();

  const promise = new Promise<string>((resolve, reject) => {
    pending.set(id, {
      resolve: (html) => {
        if (settled) return;
        settled = true;
        decrementPendingRenders();
        cacheRenderedHtml(cacheKey, html);
        resolve(html);
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        decrementPendingRenders();
        reject(error);
      },
      errorLabel: payload.errorLabel,
    });
    getWorker().postMessage(payload);
  });

  return {
    promise,
    cancel: () => {
      if (settled) return;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      settled = true;
      decrementPendingRenders();
      entry.reject(new RenderCancelledError());
    },
  };
}
