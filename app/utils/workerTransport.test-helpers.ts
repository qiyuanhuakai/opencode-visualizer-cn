export class TestRenderWorker {
  public static instances: TestRenderWorker[] = [];
  public static failNextConstruction = false;
  public onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  public onerror: ((error: unknown) => void) | null = null;
  public readonly posted: unknown[] = [];
  public terminated = false;

  public constructor() {
    if (TestRenderWorker.failNextConstruction) {
      TestRenderWorker.failNextConstruction = false;
      throw new Error('worker construction failed');
    }
    TestRenderWorker.instances.push(this);
  }

  public postMessage(message: unknown): void {
    this.posted.push(message);
  }

  public emit(data: unknown): void {
    this.onmessage?.({ data });
  }

  public crash(error: unknown): void {
    this.onerror?.(error);
  }

  public terminate(): void {
    this.terminated = true;
  }
}

export function resetTestRenderWorkers(): void {
  TestRenderWorker.instances = [];
  TestRenderWorker.failNextConstruction = false;
}

export function onlyTestRenderWorker(): TestRenderWorker {
  const worker = TestRenderWorker.instances[0];
  if (!worker) throw new Error('no dedicated stream worker');
  return worker;
}

export function streamIdOf(message: unknown): string {
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

export function postedStreamMessages(worker: TestRenderWorker): unknown[] {
  return worker.posted.filter(
    (message) => typeof message === 'object' && message !== null && 'stream' in message,
  );
}
