import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { Ref } from 'vue';

const THINKING_FRAMES = ['', '.', '..', '...'];

export function useThinkingAnimation(
  isThinking: Ref<boolean>,
  busyDescendantCount: Ref<number>,
  t: (key: string) => string,
) {
  const thinkingIndex = ref(0);
  const thinkingSuffix = ref('');
  let thinkingTimer: number | undefined;

  const thinkingDisplayText = computed(() => {
    if (!isThinking.value) return `🟢 ${t('app.status.idle')}`;
    const descendants = busyDescendantCount.value;
    const total = Math.max(1, 1 + descendants);
    const heads = '🤔'.repeat(total);
    return `${heads} ${t('app.status.thinking')}${thinkingSuffix.value}`;
  });

  watch(
    isThinking,
    (active) => {
      if (!active) {
        if (thinkingTimer !== undefined) {
          window.clearInterval(thinkingTimer);
          thinkingTimer = undefined;
        }
        thinkingIndex.value = 0;
        thinkingSuffix.value = '';
        return;
      }

      thinkingIndex.value = 0;
      thinkingSuffix.value = THINKING_FRAMES[thinkingIndex.value] ?? '';
      if (thinkingTimer !== undefined) window.clearInterval(thinkingTimer);
      thinkingTimer = window.setInterval(() => {
        thinkingIndex.value = (thinkingIndex.value + 1) % THINKING_FRAMES.length;
        thinkingSuffix.value = THINKING_FRAMES[thinkingIndex.value] ?? '';
      }, 350);
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    if (thinkingTimer !== undefined) {
      window.clearInterval(thinkingTimer);
    }
  });

  return {
    thinkingDisplayText,
  };
}
