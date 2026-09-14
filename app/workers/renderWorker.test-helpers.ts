import { ByteWeightedLruCache } from '../utils/byteWeightedLru';

export type WorkerRenderResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly html?: string;
  readonly error?: string;
};

export type WorkerRenderPayload = {
  readonly id: string;
  readonly code: string;
  readonly lang: string;
  readonly theme: string;
  readonly gutterMode: 'none';
  readonly copyButtons?: boolean;
  readonly files?: string[];
};

type WorkerSelf = {
  onmessage: ((event: { readonly data: WorkerRenderPayload }) => void) | null;
  postMessage: (message: WorkerRenderResponse) => void;
};

export type RenderWorkerHarness = {
  readonly render: (payload: WorkerRenderPayload) => Promise<string>;
  readonly cache: ByteWeightedLruCache<string, string>;
  readonly messages: readonly WorkerRenderResponse[];
  readonly activateSelf: () => void;
  readonly restoreSelf: () => void;
};

export function codeRequest(id: string, theme = 'github-dark'): WorkerRenderPayload {
  return {
    id,
    code: 'const answer: number = 42;',
    lang: 'typescript',
    theme,
    gutterMode: 'none',
  };
}

export async function installRenderWorker(moduleTag: string): Promise<RenderWorkerHarness> {
  const priorSelf = Reflect.get(globalThis, 'self');
  const messages: WorkerRenderResponse[] = [];
  const waiters = new Map<string, (message: WorkerRenderResponse) => void>();
  const worker: WorkerSelf = {
    onmessage: null,
    postMessage: (message) => {
      messages.push(message);
      waiters.get(message.id)?.(message);
      waiters.delete(message.id);
    },
  };
  Object.defineProperty(globalThis, 'self', { configurable: true, value: worker });
  await import(/* @vite-ignore */ `./render-worker?test-harness-${moduleTag}`);
  const exposedCache = Reflect.get(globalThis, '__visRenderWorkerCacheForTests');
  if (!(exposedCache instanceof ByteWeightedLruCache)) {
    throw new Error('render worker test cache is unavailable');
  }
  exposedCache.clear();

  return {
    messages,
    cache: exposedCache,
    activateSelf: () => {
      Object.defineProperty(globalThis, 'self', { configurable: true, value: worker });
    },
    render: (payload) =>
      new Promise<string>((resolve, reject) => {
        waiters.set(payload.id, (message) => {
          if (message.ok && message.html !== undefined) resolve(message.html);
          else reject(new Error(message.error ?? 'render failed'));
        });
        worker.onmessage?.({ data: payload });
      }),
    restoreSelf: () => {
      if (priorSelf === undefined) Reflect.deleteProperty(globalThis, 'self');
      else Object.defineProperty(globalThis, 'self', { configurable: true, value: priorSelf });
    },
  };
}

export function markdownRequest(id: string, code: string): WorkerRenderPayload {
  return {
    id,
    code,
    lang: 'markdown',
    theme: 'github-dark',
    gutterMode: 'none',
    copyButtons: false,
  };
}
