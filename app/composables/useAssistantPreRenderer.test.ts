import { createApp, defineComponent, nextTick, ref, type Ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageInfo } from '../types/sse';
import { useAssistantPreRenderer } from './useAssistantPreRenderer';

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
vi.mock('../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}));

type PostedRequest = {
  id: string;
  code: string;
};

type MountedRenderer = {
  readonly content: Ref<string>;
  readonly rendered: ReturnType<typeof vi.fn>;
  readonly getHtml: (rootId: string) => string | undefined;
};

const mountedApps: Array<() => void> = [];

function postedRequests(): PostedRequest[] {
  return workerState.FakeWorker.instances.flatMap(
    (worker) => worker.posted as PostedRequest[],
  );
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
}

function mountRenderer(): MountedRenderer {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const content = ref('initial content');
  const rendered = vi.fn();
  let getHtml: ((rootId: string) => string | undefined) | null = null;
  const root: MessageInfo = {
    id: 'root',
    sessionID: 'session',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'test', modelID: 'test' },
  };
  const visibleRoots = ref<MessageInfo[]>([root]);
  const app = createApp(
    defineComponent({
      setup() {
        const renderer = useAssistantPreRenderer({
          visibleRoots,
          theme: ref('github-dark'),
          filesWithBasenames: ref<string[]>([]),
          getFinalAnswer: () => undefined,
          hasAssistantMessages: () => true,
          getFinalAnswerContent: () => content.value,
          getThreadTransitionKey: () => 'transition',
          getThreadAssistantRenderKeyById: (rootId, answerId = '') => `${rootId}:${answerId}`,
          onRendered: rendered,
        });
        getHtml = renderer.getAssistantHtml;
        return () => null;
      },
    }),
  );
  app.mount(target);
  mountedApps.push(() => {
    app.unmount();
    target.remove();
  });
  if (!getHtml) throw new Error('assistant renderer did not mount');
  return { content, rendered, getHtml };
}

function emitRequest(request: PostedRequest, html: string): void {
  const worker = workerState.FakeWorker.instances.find((candidate) =>
    candidate.posted.some(
      (message) => (message as PostedRequest).id === request.id,
    ),
  );
  if (!worker) throw new Error(`worker for ${request.id} was not found`);
  worker.emit({ id: request.id, ok: true, html });
}

beforeEach(() => {
  workerState.FakeWorker.instances = [];
});

afterEach(() => {
  while (mountedApps.length > 0) mountedApps.pop()?.();
  document.body.innerHTML = '';
});

describe('useAssistantPreRenderer render queue', () => {
  it('keeps one posted render and one newest follow-up while workers stay unresolved', async () => {
    // Given: the current html has completed and a root receives many updates
    const mounted = mountRenderer();
    await settle();
    const initialRequest = postedRequests()[0];
    if (!initialRequest) throw new Error('initial render was not posted');
    emitRequest(initialRequest, '<p>initial html</p>');
    await settle();
    expect(mounted.getHtml('root')).toBe('<p>initial html</p>');

    const firstUpdate = 'update-1';
    mounted.content.value = firstUpdate;
    await nextTick();
    for (let index = 2; index <= 12; index += 1) {
      mounted.content.value = `update-${index}`;
      await nextTick();
    }

    // When: the first update remains unresolved
    const requestsBeforeCompletion = postedRequests();

    // Then: only that update is in flight and the newest payload is retained
    expect(requestsBeforeCompletion).toHaveLength(2);
    expect(requestsBeforeCompletion[1]?.code).toBe(firstUpdate);
    expect(mounted.getHtml('root')).toBe('<p>initial html</p>');

    // When: the obsolete in-flight update completes
    emitRequest(requestsBeforeCompletion[1] as PostedRequest, '<p>stale html</p>');
    await settle();

    // Then: the stale result is never applied and exactly one latest follow-up is posted
    const requestsAfterFirstCompletion = postedRequests();
    expect(requestsAfterFirstCompletion).toHaveLength(3);
    expect(requestsAfterFirstCompletion[2]?.code).toBe('update-12');
    expect(mounted.getHtml('root')).toBe('<p>initial html</p>');

    emitRequest(requestsAfterFirstCompletion[2] as PostedRequest, '<p>latest html</p>');
    await settle();
    expect(mounted.getHtml('root')).toBe('<p>latest html</p>');
    expect(mounted.rendered).toHaveBeenLastCalledWith('root:root');
  });
});
