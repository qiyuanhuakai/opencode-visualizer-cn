import { createApp, defineComponent, h, reactive } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Reasoning from './Reasoning.vue';
import Subagent from './Subagent.vue';
import { FLOATING_WINDOW_KEY } from '../../composables/useFloatingWindow';
import {
  beginRenderScenario,
  flushRenderRequests,
  renderCursor as cursor,
  renderRequestsSince as requestsSince,
  type WorkerCursor as Cursor,
} from '../streamingComponents.test-helpers';

let testStart: Cursor = [];

function flushRenders(): Promise<void> {
  return flushRenderRequests(
    (request) => `<div class="seg" data-len="${request.code.length}">${request.code}</div>`,
  );
}

vi.mock('../../workers/render-worker?worker', async () => {
  const helper = await import('../streamingComponents.test-helpers');
  return { default: helper.StreamingTestWorker };
});

function createMessages() {
  return {
    en: {
      messageViewer: { rendered: 'Rendered', source: 'Source' },
      render: {
        copyCode: 'Copy code',
        copied: 'Copied',
        copyCodeAria: 'Copy code aria',
        copyMarkdownAria: 'Copy markdown aria',
      },
      common: { loading: 'Loading' },
    },
  };
}

function createFloatingWindow(key: string) {
  return {
    key,
    content: { value: '' },
    html: { value: '' },
    title: { value: '' },
    status: { value: '' },
    notifyContentChange: vi.fn(),
    setContent: vi.fn(),
    appendContent: vi.fn(),
    setTitle: vi.fn(),
    setStatus: vi.fn(),
    setColor: vi.fn(),
    bringToFront: vi.fn(),
    minimize: vi.fn(),
    close: vi.fn(),
    onResize: vi.fn(),
  };
}

const streamingComponents = [
  {
    name: 'Subagent',
    component: Subagent,
    floatingWindow: createFloatingWindow('test-subagent'),
  },
  {
    name: 'Reasoning',
    component: Reasoning,
    floatingWindow: createFloatingWindow('test-reasoning'),
  },
] as const;

type StreamingComponent = (typeof streamingComponents)[number];

const mountedApps: Array<() => void> = [];

function mountStreamingComponent(
  fixture: StreamingComponent,
  initialEntries: Array<{ id: string; text: string; completed?: boolean }>,
): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(fixture.component, { entries: initialEntries });
      },
    }),
  );
  app.provide(FLOATING_WINDOW_KEY, fixture.floatingWindow);
  app.use(createI18n({ legacy: false, locale: 'en', messages: createMessages() }));
  app.mount(target);
  mountedApps.push(() => {
    app.unmount();
    target.remove();
  });
  return target;
}

beforeEach(() => {
  // Workers are pooled and reused across mounts, so keep the instance list and
  // mark prior requests as responded instead of clearing state.
  testStart = beginRenderScenario();
});

afterEach(() => {
  while (mountedApps.length > 0) mountedApps.pop()?.();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe.each(streamingComponents)('$name streaming prop', (fixture) => {
  it('takes streaming segment path for incomplete entries (completed=false)', async () => {
    // Given: an entry marked as still growing (text is fixture-scoped because
    // workerRenderer keeps a module-level HTML cache shared by both components)
    const start = `# ${fixture.name} Start`;
    const entries = reactive([{ id: 'part-1', text: start, completed: false }]);
    mountStreamingComponent(fixture, entries);
    await flushRenders();

    // When: the text grows across a paragraph boundary
    const grown = `${start}\n\nBody.`;
    entries[0].text = grown;
    await flushRenders();

    // Then: streaming segment path taken — partial segment appears, not full code
    const codes = requestsSince(testStart).map((r) => r.code);
    expect(codes).toContain(`${start}\n\n`);
    expect(codes).not.toContain(grown);
  });

  it('takes full code path for completed entries (completed=true)', async () => {
    // Given: an entry marked completed
    const complete = `# ${fixture.name} Complete thought`;
    mountStreamingComponent(fixture, [{ id: 'part-1', text: complete, completed: true }]);
    await flushRenders();

    // Then: full code path — the complete text is rendered as one request
    const requests = requestsSince(testStart);
    expect(requests).toHaveLength(1);
    expect(requests[0].code).toBe(complete);
  });

  it('flips from streaming to non-streaming when entry completes (convergence)', async () => {
    // Given: an incomplete entry
    const start = `# ${fixture.name} Start`;
    const entries = reactive([{ id: 'part-1', text: start, completed: false }]);
    mountStreamingComponent(fixture, entries);
    await flushRenders();
    const beforeCursor = cursor();

    // When: the entry completes with more text
    const finished = `${start}\n\nFinished.`;
    entries[0].completed = true;
    entries[0].text = finished;
    await flushRenders();

    // Then: new requests reflect non-streaming (full code)
    const newRequests = requestsSince(beforeCursor);
    const newCodes = newRequests.map((r) => r.code);
    expect(newCodes).toContain(finished);
  });
});
