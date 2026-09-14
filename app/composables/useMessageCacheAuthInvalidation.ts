import { watch, type ComputedRef, type Ref } from 'vue';

export type MessageCacheAuthInvalidationOptions = {
  readonly authHeader: ComputedRef<string | undefined>;
  readonly codexBridgeToken: Ref<string>;
  readonly acpBridgeToken: Ref<string>;
  readonly messageCacheAuthGeneration: Ref<number>;
  readonly sessionReloadRequestId: Ref<number>;
  readonly clearSessionCache: () => void;
  readonly invalidateMessageCacheContext: () => void;
};

export function useMessageCacheAuthInvalidation(
  options: MessageCacheAuthInvalidationOptions,
): () => void {
  return watch(
    [options.authHeader, options.codexBridgeToken, options.acpBridgeToken],
    () => {
      options.messageCacheAuthGeneration.value += 1;
      options.sessionReloadRequestId.value += 1;
      options.clearSessionCache();
      options.invalidateMessageCacheContext();
    },
    { flush: 'sync' },
  );
}
