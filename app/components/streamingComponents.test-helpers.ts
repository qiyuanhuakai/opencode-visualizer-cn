import { nextTick } from 'vue';

export type PostedRenderRequest = {
  readonly id: string;
  readonly code: string;
  readonly lang: string;
  readonly theme: string;
  readonly gutterMode?: string;
  readonly copyButtonLabel?: string;
  readonly copiedLabel?: string;
  readonly copyCodeAriaLabel?: string;
  readonly copyMarkdownAriaLabel?: string;
};

export class StreamingTestWorker {
  public static instances: StreamingTestWorker[] = [];
  public onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  public onerror: ((error: unknown) => void) | null = null;
  public readonly posted: unknown[] = [];

  public constructor() {
    StreamingTestWorker.instances.push(this);
  }

  public postMessage(message: unknown): void {
    this.posted.push(message);
  }

  public emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

export type WorkerCursor = readonly number[];

const respondedIds = new Set<string>();

export function postedRenderRequests(): PostedRenderRequest[] {
  return StreamingTestWorker.instances.flatMap((worker) =>
    worker.posted.filter(isPostedRenderRequest),
  );
}

export function renderCursor(): WorkerCursor {
  return StreamingTestWorker.instances.map((worker) => worker.posted.length);
}

export function renderRequestsSince(from: WorkerCursor): PostedRenderRequest[] {
  return StreamingTestWorker.instances.flatMap((worker, index) =>
    worker.posted.slice(from[index] ?? 0).filter(isPostedRenderRequest),
  );
}

export function beginRenderScenario(): WorkerCursor {
  const start = renderCursor();
  for (const request of postedRenderRequests()) respondedIds.add(request.id);
  return start;
}

export async function settleRendering(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

export async function flushRenderRequests(
  responseFor: (request: PostedRenderRequest) => string,
): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    let answered = 0;
    for (const worker of StreamingTestWorker.instances) {
      for (const message of worker.posted) {
        if (!isPostedRenderRequest(message) || respondedIds.has(message.id)) continue;
        respondedIds.add(message.id);
        worker.emit({ id: message.id, ok: true, html: responseFor(message) });
        answered += 1;
      }
    }
    await settleRendering();
    if (answered === 0 && postedRenderRequests().every((request) => respondedIds.has(request.id))) {
      return;
    }
  }
  throw new Error('flushRenderRequests did not quiesce');
}

export function markRenderRequestResponded(id: string): void {
  respondedIds.add(id);
}

export function isRenderRequestResponded(id: string): boolean {
  return respondedIds.has(id);
}

function isPostedRenderRequest(message: unknown): message is PostedRenderRequest {
  return (
    typeof message === 'object' &&
    message !== null &&
    'id' in message &&
    typeof message.id === 'string' &&
    'code' in message &&
    typeof message.code === 'string'
  );
}
