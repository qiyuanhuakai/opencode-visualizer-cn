import RenderWorker from '../workers/render-worker?worker';

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
  // Localization strings for copy buttons
  copyButtonLabel?: string;
  copiedLabel?: string;
  copyCodeAriaLabel?: string;
  copyMarkdownAriaLabel?: string;
  // Error message localization
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

let renderWorker: Worker | null = null;
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

function getWorker() {
  if (renderWorker) return renderWorker;
  const worker = new RenderWorker();
  renderWorker = worker;
  worker.onmessage = (event: MessageEvent<RenderResponse>) => {
    const data = event.data;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) entry.resolve(data.html);
    else entry.reject(new Error(data.error || entry.errorLabel || 'Render failed'));
  };
  worker.onerror = (error) => {
    pending.forEach((entry) => entry.reject(new Error(String(error))));
    pending.clear();
  };
  return worker;
}

export function renderWorkerHtml(payload: RenderRequest) {
  const cacheKey = getCacheKey(payload);
  const cached = completedCache.get(cacheKey);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  const id = payload.id;
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

  const promise = new Promise<string>((resolve, reject) => {
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
      entry.reject(new RenderCancelledError());
    },
  };
}
