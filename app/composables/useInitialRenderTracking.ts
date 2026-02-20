import { ref, watch } from 'vue';
import type { Ref } from 'vue';
import type { MessageInfo } from '../types/sse';

type UseInitialRenderTrackingOptions = {
  visibleRoots: Ref<MessageInfo[]>;
  hasAssistantMessages: (root: MessageInfo) => boolean;
  getThreadUserRenderKey: (root: MessageInfo) => string;
  getThreadAssistantRenderKey: (root: MessageInfo) => string;
  onInitialRenderComplete: () => void;
  onMessageRendered: () => void;
};

export function useInitialRenderTracking(options: UseInitialRenderTrackingOptions) {
  const pendingInitialRenderKeys = ref(new Set<string>());
  const initialRenderTrackingActive = ref(false);
  const renderedKeys = ref(new Set<string>());

  function collectInitialRenderKeys(): Set<string> {
    const keys = new Set<string>();
    options.visibleRoots.value.forEach((root) => {
      keys.add(options.getThreadUserRenderKey(root));
      if (options.hasAssistantMessages(root)) keys.add(options.getThreadAssistantRenderKey(root));
    });
    return keys;
  }

  function beginInitialRenderTracking() {
    const keys = collectInitialRenderKeys();
    pendingInitialRenderKeys.value = keys;
    initialRenderTrackingActive.value = keys.size > 0;
    if (keys.size === 0) options.onInitialRenderComplete();
  }

  function handleMessageRendered(renderKey: string) {
    renderedKeys.value.add(renderKey);
    options.onMessageRendered();
    if (!initialRenderTrackingActive.value) return;
    const keys = pendingInitialRenderKeys.value;
    keys.delete(renderKey);
    if (keys.size > 0) return;
    initialRenderTrackingActive.value = false;
    options.onInitialRenderComplete();
  }

  watch(
    () => options.visibleRoots.value.length,
    (length, previous) => {
      if (length === 0) {
        pendingInitialRenderKeys.value = new Set<string>();
        initialRenderTrackingActive.value = false;
        renderedKeys.value = new Set<string>();
        return;
      }
      if (previous === 0) beginInitialRenderTracking();
    },
  );

  return {
    initialRenderTrackingActive,
    beginInitialRenderTracking,
    handleMessageRendered,
  };
}
