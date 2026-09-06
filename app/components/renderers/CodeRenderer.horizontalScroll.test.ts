import { createApp, defineComponent, h, nextTick, reactive } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettings } from '../../composables/useSettings';

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
  }
  return { FakeWorker };
});

vi.mock('../../workers/render-worker?worker', () => ({ default: workerState.FakeWorker }));

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import CodeRenderer from './CodeRenderer.vue';

async function settle(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

const mountedApps: Array<() => void> = [];

function mountCodeRenderer(initialProps: Record<string, unknown>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const props = reactive({ ...initialProps });
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(CodeRenderer, { ...props });
      },
    }),
  );
  app.mount(target);
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    app.unmount();
    target.remove();
  };
  mountedApps.push(unmount);
  return { target, unmount };
}

function buildRows(rowCount: number, longLineAt: number): string {
  const longLine = 'x'.repeat(4_000);
  return Array.from({ length: rowCount }, (_, index) => {
    const content = index === longLineAt ? longLine : `line ${index}`;
    return `<div class="code-row"><span class="code-gutter">${index + 1}</span><span class="code-gutter"></span><span class="line">${content}</span></div>`;
  }).join('');
}

beforeEach(() => {
  vi.useFakeTimers();
  useSettings().floatingPreviewWordWrap.value = false;
});

afterEach(() => {
  vi.useRealTimers();
  while (mountedApps.length > 0) mountedApps.pop()?.();
  document.body.innerHTML = '';
});

describe('CodeRenderer horizontal scrolling when wrapping is off', () => {
  it('does not retain the viewport width as intrinsic line overflow', async () => {
    const mounted = mountCodeRenderer({ rawHtml: buildRows(600, -1), fileContent: 'placeholder', lang: 'text' });
    await settle();
    const body = mounted.target.querySelector<HTMLElement>('.viewer-body');
    if (!body) throw new Error('missing viewer body');
    Object.defineProperty(body, 'clientWidth', { configurable: true, value: 820 });
    mounted.target.querySelectorAll('.code-row').forEach((row) => {
      Object.defineProperty(row, 'scrollWidth', { configurable: true, value: 820 });
    });
    window.dispatchEvent(new Event('resize'));
    await settle();
    expect(mounted.target.querySelector<HTMLElement>('.virtual-row')?.style.minWidth).toBe('');
  });

  it('marks unwrapped virtual rows so long lines overflow instead of being clipped', async () => {
    // Given: a virtualized (>500 rows) code preview with wrapping disabled and one very long line
    const mounted = mountCodeRenderer({
      rawHtml: buildRows(600, 42),
      fileContent: 'placeholder',
      lang: 'text',
    });
    await settle();

    // When: the virtual scroll container renders a bounded window of rows
    const container = mounted.target.querySelector<HTMLElement>(
      '.code-scroll-content.virtual-scroll',
    );
    expect(container).not.toBeNull();
    const virtualRows = mounted.target.querySelectorAll('.virtual-row');
    expect(virtualRows.length).toBeGreaterThan(0);
    expect(virtualRows.length).toBeLessThan(600);

    // Then: the container opts out of width-capped clipping so a horizontal scrollbar can appear
    expect(container?.classList.contains('wrap-off')).toBe(true);
  });

  it('keeps wrapped virtual rows constrained to the preview width', async () => {
    // Given: a virtualized code preview with wrapping enabled
    useSettings().floatingPreviewWordWrap.value = true;
    const mounted = mountCodeRenderer({
      rawHtml: buildRows(600, 42),
      fileContent: 'placeholder',
      lang: 'text',
    });
    await settle();

    // When: the virtual scroll container renders
    const container = mounted.target.querySelector<HTMLElement>(
      '.code-scroll-content.virtual-scroll',
    );
    expect(container).not.toBeNull();
    expect(mounted.target.querySelectorAll('.virtual-row').length).toBeGreaterThan(0);

    // Then: rows stay width-capped so soft wrapping can measure against the preview width
    expect(container?.classList.contains('wrap-off')).toBe(false);
  });
});
