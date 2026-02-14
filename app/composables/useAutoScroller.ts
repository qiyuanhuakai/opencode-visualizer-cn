import { ref, computed, watch, onUnmounted, type Ref } from 'vue';

export type ScrollMode = 'follow' | 'force' | 'manual' | 'none';

const BOTTOM_THRESHOLD_PX = 8;
const SCROLL_SPEED_PX_PER_MS = 1.5;
const INTERVENTION_TOLERANCE_PX = 2;
const MAX_FRAME_DT_MS = 50;
const POPUP_DURATION_MS = 150;
const NATIVE_SMOOTH_TIMEOUT_MS = 1_500;
const USER_SCROLL_INTENT_WINDOW_MS = 240;

type SmoothEngine = 'raf' | 'native';

type ScrollFollowOptions = {
  bottomThresholdPx?: number;
  observeDelayMs?: number;
  smoothEngine?: SmoothEngine;
  smoothOnInitialFollow?: boolean;
  enabled?: boolean;
};

function followDebug(event: string, detail?: Record<string, unknown>) {
  const t = typeof performance !== 'undefined' ? Number(performance.now().toFixed(1)) : 0;
  if (detail) {
    console.debug(`[follow] ${event}`, { t, ...detail });
    return;
  }
  console.debug(`[follow] ${event}`, { t });
}

export function useAutoScroller(
  containerEl: Ref<HTMLElement | undefined>,
  scrollMode: Ref<ScrollMode>,
  options: ScrollFollowOptions = {},
) {
  const bottomThresholdPx = options.bottomThresholdPx ?? BOTTOM_THRESHOLD_PX;
  const smoothEngine = options.smoothEngine ?? 'raf';
  const smoothOnInitialFollow = options.smoothOnInitialFollow ?? true;
  const isFollowing = ref(scrollMode.value === 'follow' || scrollMode.value === 'force');
  const isTrackingPaused = ref(options.enabled === false);

  let rafId: number | null = null;
  let popupTimerId: ReturnType<typeof setTimeout> | null = null;
  let animating = false;
  let lastSetScrollTop = -1;
  let lastObservedScrollTop = 0;
  let lastObservedScrollHeight = 0;
  let contentChangeScheduled = false;
  let nativeSmoothMonitorTimeout: ReturnType<typeof setTimeout> | null = null;
  let nativeSmoothCleanup: (() => void) | null = null;
  let lastUserScrollIntentAt = 0;
  let pointerInteracting = false;

  function nowMs() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  function markUserScrollIntent(source: string) {
    lastUserScrollIntentAt = nowMs();
    followDebug('userScrollIntent', { source });
  }

  function hasRecentUserScrollIntent() {
    return pointerInteracting || nowMs() - lastUserScrollIntentAt <= USER_SCROLL_INTENT_WINDOW_MS;
  }

  const showResumeButton = computed(() => {
    return scrollMode.value === 'follow' && !isFollowing.value;
  });

  function isAtBottom(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= bottomThresholdPx;
  }

  function cancelAnimation() {
    animating = false;
    lastSetScrollTop = -1;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function pauseTracking() {
    isTrackingPaused.value = true;
    followDebug('pauseTracking');
  }

  function resumeTracking(options: { syncToBottom?: boolean } = {}) {
    followDebug('resumeTracking:start', {
      wasPaused: isTrackingPaused.value,
      syncToBottom: Boolean(options.syncToBottom),
      isFollowing: isFollowing.value,
    });
    if (!isTrackingPaused.value) {
      if (options.syncToBottom) scrollToBottom(false);
      followDebug('resumeTracking:already-active');
      return;
    }
    isTrackingPaused.value = false;
    if (options.syncToBottom) {
      isFollowing.value = true;
      followDebug('resumeTracking:done', {
        isFollowing: true,
        syncToBottom: true,
      });
      scrollToBottom(false);
    } else if (scrollMode.value === 'follow') {
      const el = containerEl.value;
      if (el) {
        isFollowing.value = isAtBottom(el);
        followDebug('resumeTracking:done', {
          isFollowing: isFollowing.value,
          atBottom: isAtBottom(el),
        });
      }
    }
  }

  function runWithoutTracking<T>(fn: () => T): T {
    const wasPaused = isTrackingPaused.value;
    isTrackingPaused.value = true;
    try {
      return fn();
    } finally {
      if (!wasPaused) resumeTracking();
    }
  }

  function clearNativeSmoothMonitor() {
    if (nativeSmoothMonitorTimeout !== null) {
      clearTimeout(nativeSmoothMonitorTimeout);
      nativeSmoothMonitorTimeout = null;
    }
    if (nativeSmoothCleanup) {
      nativeSmoothCleanup();
      nativeSmoothCleanup = null;
    }
  }

  function startNativeSmoothMonitor(el: HTMLElement) {
    clearNativeSmoothMonitor();
    pauseTracking();

    let done = false;
    let cleanupBound = false;

    const finish = () => {
      if (done) return;
      done = true;
      if (cleanupBound) {
        el.removeEventListener('scrollend', onScrollEnd as EventListener);
        cleanupBound = false;
      }
      if (nativeSmoothMonitorTimeout !== null) {
        clearTimeout(nativeSmoothMonitorTimeout);
        nativeSmoothMonitorTimeout = null;
      }
      nativeSmoothCleanup = null;
      resumeTracking();
      isFollowing.value = true;
    };

    const onScrollEnd = () => {
      finish();
    };

    el.addEventListener('scrollend', onScrollEnd as EventListener);
    cleanupBound = true;
    nativeSmoothMonitorTimeout = setTimeout(() => {
      finish();
    }, NATIVE_SMOOTH_TIMEOUT_MS);
    nativeSmoothCleanup = finish;
  }

  function scrollToBottom(smooth: boolean) {
    const el = containerEl.value;
    if (!el) return;
    const target = el.scrollHeight - el.clientHeight;
    if (target <= 0) return;
    if (Math.abs(el.scrollTop - target) < 1) return;
    followDebug('scrollToBottom:start', {
      smooth,
      from: el.scrollTop,
      target,
      isFollowing: isFollowing.value,
    });

    if (!smooth) {
      clearNativeSmoothMonitor();
      cancelAnimation();
      el.scrollTop = target;
      lastSetScrollTop = target;
      lastObservedScrollTop = target;
      lastObservedScrollHeight = el.scrollHeight;
      followDebug('scrollToBottom:jump', { top: el.scrollTop, target });
      return;
    }

    if (smoothEngine === 'native') {
      cancelAnimation();
      startNativeSmoothMonitor(el);
      el.scrollTo({ top: target, behavior: 'smooth' });
      lastSetScrollTop = target;
      return;
    }

    clearNativeSmoothMonitor();

    if (animating) return;

    animating = true;
    let lastTime = performance.now();
    lastSetScrollTop = el.scrollTop;

    function frame(now: number) {
      const el = containerEl.value;
      if (!el || !animating) {
        animating = false;
        return;
      }

      if (
        lastSetScrollTop >= 0 &&
        Math.abs(el.scrollTop - lastSetScrollTop) > INTERVENTION_TOLERANCE_PX
      ) {
        animating = false;
        lastSetScrollTop = -1;
        if (scrollMode.value === 'follow') {
          isFollowing.value = isAtBottom(el);
        }
        followDebug('scrollToBottom:intervened', {
          top: el.scrollTop,
          lastSetScrollTop,
          isFollowing: isFollowing.value,
        });
        return;
      }

      const dt = Math.min(now - lastTime, MAX_FRAME_DT_MS);
      lastTime = now;
      const target = el.scrollHeight - el.clientHeight;
      const remaining = target - el.scrollTop;

      if (remaining <= 0.5) {
        el.scrollTop = target;
        lastSetScrollTop = target;
        animating = false;
        followDebug('scrollToBottom:raf-complete', { top: el.scrollTop, target });
        return;
      }

      const step = SCROLL_SPEED_PX_PER_MS * dt;
      const newTop = Math.min(el.scrollTop + step, target);
      el.scrollTop = newTop;
      lastSetScrollTop = newTop;

      rafId = requestAnimationFrame(frame);
    }

    rafId = requestAnimationFrame(frame);
  }

  function scheduleAutoScroll(smooth: boolean) {
    if (isTrackingPaused.value) {
      followDebug('scheduleAutoScroll:skip-paused', { smooth });
      return;
    }
    if (contentChangeScheduled) {
      followDebug('scheduleAutoScroll:skip-queued', { smooth });
      return;
    }
    contentChangeScheduled = true;
    followDebug('scheduleAutoScroll:queued', {
      smooth,
      mode: scrollMode.value,
      isFollowing: isFollowing.value,
    });
    requestAnimationFrame(() => {
      contentChangeScheduled = false;
      const m = scrollMode.value;
      followDebug('scheduleAutoScroll:run', {
        smooth,
        mode: m,
        isFollowing: isFollowing.value,
      });
      if (m === 'force') {
        scrollToBottom(smooth);
      } else if (m === 'follow' && isFollowing.value) {
        scrollToBottom(smooth);
      }
    });
  }

  function onScroll() {
    if (isTrackingPaused.value) return;
    if (animating) return;
    if (scrollMode.value !== 'follow') return;
    const el = containerEl.value;
    if (!el) return;
    const atBottom = isAtBottom(el);
    const delta = el.scrollTop - lastObservedScrollTop;
    const scrollHeightDelta = el.scrollHeight - lastObservedScrollHeight;
    const hasUserIntent = hasRecentUserScrollIntent();
    lastObservedScrollTop = el.scrollTop;
    lastObservedScrollHeight = el.scrollHeight;
    followDebug('onScroll', {
      top: el.scrollTop,
      delta,
      scrollHeight: el.scrollHeight,
      scrollHeightDelta,
      clientHeight: el.clientHeight,
      atBottom,
      hasUserIntent,
      isFollowingBefore: isFollowing.value,
      lastSetScrollTop,
    });
    if (atBottom) {
      isFollowing.value = true;
      followDebug('onScroll:setFollowing', { isFollowing: true, reason: 'at-bottom' });
      return;
    }
    if (!isFollowing.value) {
      followDebug('onScroll:setFollowing', { isFollowing: false, reason: 'already-unlocked' });
      return;
    }
    if (
      lastSetScrollTop >= 0 &&
      Math.abs(el.scrollTop - lastSetScrollTop) <= INTERVENTION_TOLERANCE_PX
    ) {
      followDebug('onScroll:setFollowing', {
        isFollowing: true,
        reason: 'programmatic-near-target',
      });
      return;
    }
    if (delta < -INTERVENTION_TOLERANCE_PX && scrollHeightDelta <= 0 && hasUserIntent) {
      isFollowing.value = false;
      followDebug('onScroll:setFollowing', { isFollowing: false, reason: 'scroll-up' });
      return;
    }
    followDebug('onScroll:setFollowing', { isFollowing: true, reason: 'keep-locked' });
  }

  function resumeFollow(smooth = true) {
    isFollowing.value = true;
    followDebug('resumeFollow', { smooth });
    scrollToBottom(smooth);
  }

  function notifyContentChange(smooth = true) {
    followDebug('notifyContentChange', { smooth });
    scheduleAutoScroll(smooth);
  }

  function setup(el: HTMLElement) {
    followDebug('setup', { top: el.scrollTop });
    lastObservedScrollTop = el.scrollTop;
    lastObservedScrollHeight = el.scrollHeight;
    el.addEventListener('scroll', onScroll, { passive: true });
    const wheelIntentHandler = () => markUserScrollIntent('wheel');
    const touchIntentHandler = () => markUserScrollIntent('touchmove');
    const pointerDownIntentHandler = () => {
      pointerInteracting = true;
      markUserScrollIntent('pointerdown');
    };
    el.addEventListener('wheel', wheelIntentHandler, { passive: true });
    el.addEventListener('touchmove', touchIntentHandler, { passive: true });
    el.addEventListener('pointerdown', pointerDownIntentHandler);
    const clearPointerInteraction = () => {
      pointerInteracting = false;
    };
    window.addEventListener('pointerup', clearPointerInteraction);
    window.addEventListener('pointercancel', clearPointerInteraction);
    (
      el as HTMLElement & {
        __clearPointerInteraction?: () => void;
        __wheelIntentHandler?: () => void;
        __touchIntentHandler?: () => void;
        __pointerDownIntentHandler?: () => void;
      }
    ).__clearPointerInteraction = clearPointerInteraction;
    (
      el as HTMLElement & {
        __clearPointerInteraction?: () => void;
        __wheelIntentHandler?: () => void;
        __touchIntentHandler?: () => void;
        __pointerDownIntentHandler?: () => void;
      }
    ).__wheelIntentHandler = wheelIntentHandler;
    (
      el as HTMLElement & {
        __clearPointerInteraction?: () => void;
        __wheelIntentHandler?: () => void;
        __touchIntentHandler?: () => void;
        __pointerDownIntentHandler?: () => void;
      }
    ).__touchIntentHandler = touchIntentHandler;
    (
      el as HTMLElement & {
        __clearPointerInteraction?: () => void;
        __wheelIntentHandler?: () => void;
        __touchIntentHandler?: () => void;
        __pointerDownIntentHandler?: () => void;
      }
    ).__pointerDownIntentHandler = pointerDownIntentHandler;

    if (scrollMode.value === 'follow' || scrollMode.value === 'force') {
      scrollToBottom(smoothOnInitialFollow);
    }
  }

  function teardown(el: HTMLElement) {
    followDebug('teardown', { top: el.scrollTop });
    el.removeEventListener('scroll', onScroll);
    const clearPointerInteraction = (el as HTMLElement & { __clearPointerInteraction?: () => void })
      .__clearPointerInteraction;
    const wheelIntentHandler = (el as HTMLElement & { __wheelIntentHandler?: () => void })
      .__wheelIntentHandler;
    const touchIntentHandler = (el as HTMLElement & { __touchIntentHandler?: () => void })
      .__touchIntentHandler;
    const pointerDownIntentHandler = (
      el as HTMLElement & { __pointerDownIntentHandler?: () => void }
    ).__pointerDownIntentHandler;
    if (wheelIntentHandler) el.removeEventListener('wheel', wheelIntentHandler);
    if (touchIntentHandler) el.removeEventListener('touchmove', touchIntentHandler);
    if (pointerDownIntentHandler) el.removeEventListener('pointerdown', pointerDownIntentHandler);
    if (clearPointerInteraction) {
      window.removeEventListener('pointerup', clearPointerInteraction);
      window.removeEventListener('pointercancel', clearPointerInteraction);
    }
    if (popupTimerId !== null) {
      clearTimeout(popupTimerId);
      popupTimerId = null;
    }
    clearNativeSmoothMonitor();
    cancelAnimation();
  }

  watch(containerEl, (newEl, oldEl) => {
    if (oldEl) teardown(oldEl);
    if (newEl) setup(newEl);
  });

  watch(scrollMode, (m) => {
    isFollowing.value = m === 'follow' || m === 'force';
  });

  onUnmounted(() => {
    if (containerEl.value) teardown(containerEl.value);
    clearNativeSmoothMonitor();
    cancelAnimation();
  });

  return {
    isTrackingPaused: computed(() => isTrackingPaused.value),
    isFollowing: computed(() => isFollowing.value),
    showResumeButton,
    pauseTracking,
    resumeTracking,
    runWithoutTracking,
    resumeFollow,
    scrollToBottom,
    notifyContentChange,
  };
}
