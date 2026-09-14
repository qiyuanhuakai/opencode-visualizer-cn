import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAutoScroller, type ScrollMode } from './useAutoScroller';

function createScroller() {
  const element = document.createElement('div');
  let scrollTop = 0;
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, value: 3_000 },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    },
  });
  const scrollTo = vi.fn((optionsOrX?: ScrollToOptions | number, y?: number) => {
    const top = typeof optionsOrX === 'number' ? y : optionsOrX?.top;
    if (typeof top === 'number') scrollTop = top;
  });
  element.scrollTo = scrollTo as HTMLElement['scrollTo'];
  return { element, scrollTo };
}

const mountedApps: Array<() => void> = [];
const trackedScrollers: Array<ReturnType<typeof useAutoScroller>> = [];

function trackScroller(scroller: ReturnType<typeof useAutoScroller>) {
  trackedScrollers.push(scroller);
  return scroller;
}

describe('useAutoScroller', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(async () => {
    while (mountedApps.length > 0) mountedApps.pop()?.();
    while (trackedScrollers.length > 0) trackedScrollers.pop()?.pauseTracking();
    if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await new Promise<void>(resolve => setImmediate(resolve));
  });

  it('snaps after a completion DOM swap clamps the followed position to the top', async () => {
    const container = ref<HTMLElement>();
    const mode = ref<ScrollMode>('manual');
    const scroller = trackScroller(useAutoScroller(container, mode, {
      smoothEngine: 'native',
      smoothOnInitialFollow: false,
    }));
    const { element, scrollTo } = createScroller();
    container.value = element;
    await nextTick();
    mode.value = 'follow';
    await nextTick();
    element.scrollTop = 0;

    scroller.notifyContentChange(true);

    expect(scrollTo).not.toHaveBeenCalled();
    expect(element.scrollTop).toBe(2_400);
  });

  it('keeps smooth follow for small streaming growth', async () => {
    const container = ref<HTMLElement>();
    const mode = ref<ScrollMode>('manual');
    const scroller = trackScroller(useAutoScroller(container, mode, {
      smoothEngine: 'native',
      smoothOnInitialFollow: false,
    }));
    const { element, scrollTo } = createScroller();
    container.value = element;
    await nextTick();
    mode.value = 'follow';
    await nextTick();
    element.scrollTop = 2_320;

    scroller.notifyContentChange(true);

    expect(scrollTo).toHaveBeenCalledWith({ top: 2_400, behavior: 'smooth' });
  });

  it('continues following when animation frames are suspended', async () => {
    const container = ref<HTMLElement>();
    const mode = ref<ScrollMode>('follow');
    const scroller = trackScroller(useAutoScroller(container, mode, { smoothOnInitialFollow: false }));
    const { element } = createScroller();
    container.value = element;
    await nextTick();
    element.scrollTop = 0;
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    try {
      scroller.notifyContentChange(false);
      await vi.advanceTimersByTimeAsync(50);
      expect(element.scrollTop).toBe(2_400);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending content-change frame when the container is replaced', async () => {
    const container = ref<HTMLElement>();
    const mode = ref<ScrollMode>('follow');
    const scroller = trackScroller(useAutoScroller(container, mode, { smoothOnInitialFollow: false }));
    const { element } = createScroller();
    container.value = element;
    await nextTick();
    const cancelFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 7));
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);

    scroller.notifyContentChange(false);
    container.value = undefined;
    await nextTick();

    expect(cancelFrame).toHaveBeenCalledWith(7);
  });

  it('removes global listeners and pending work during component unmount', async () => {
    const target = document.createElement('div');
    const addWindowListener = vi.spyOn(window, 'addEventListener');
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');
    vi.useFakeTimers();
    const cancelFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 7));
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    let notifyContentChange: (() => void) | undefined;
    const component = defineComponent({
      setup() {
        const container = ref<HTMLElement>();
        const mode = ref<ScrollMode>('follow');
        const scroller = useAutoScroller(container, mode, { smoothOnInitialFollow: false });
        notifyContentChange = () => scroller.notifyContentChange(false);
        return () => h('div', { ref: container });
      },
    });
    const app = createApp(component);
    app.mount(target);
    const disposeApp = () => {
      const index = mountedApps.indexOf(disposeApp);
      if (index >= 0) mountedApps.splice(index, 1);
      app.unmount();
      target.remove();
    };
    mountedApps.push(disposeApp);
    await nextTick();
    notifyContentChange?.();
    const pointerUpHandler = addWindowListener.mock.calls.find(
      ([type]) => type === 'pointerup',
    )?.[1];
    const pointerCancelHandler = addWindowListener.mock.calls.find(
      ([type]) => type === 'pointercancel',
    )?.[1];

    disposeApp();

    expect(removeWindowListener).toHaveBeenCalledWith('pointerup', pointerUpHandler);
    expect(removeWindowListener).toHaveBeenCalledWith('pointercancel', pointerCancelHandler);
    expect(cancelFrame).toHaveBeenCalledWith(7);
  });
});
