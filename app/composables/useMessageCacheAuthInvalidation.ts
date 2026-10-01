import { watch, type ComputedRef, type Ref, type WatchSource } from 'vue';

export type MessageCacheAuthInvalidationOptions = {
  readonly authHeader: ComputedRef<string | undefined>;
  readonly codexBridgeToken: Ref<string>;
  readonly acpBridgeToken: Ref<string>;
  readonly kimiWebBridgeToken: Ref<string>;
  readonly dshBridgeToken?: Ref<string>;
  readonly messageCacheAuthGeneration: Ref<number>;
  readonly sessionReloadRequestId: Ref<number>;
  readonly clearSessionCache: () => void;
  readonly invalidateMessageCacheContext: () => void;
};

export function useMessageCacheAuthInvalidation(
  options: MessageCacheAuthInvalidationOptions,
): () => void {
  const sources: WatchSource[] = [
    options.authHeader,
    options.codexBridgeToken,
    options.acpBridgeToken,
    options.kimiWebBridgeToken,
  ];
  if (options.dshBridgeToken) sources.push(options.dshBridgeToken);
  return watch(
    sources,
    () => {
      options.messageCacheAuthGeneration.value += 1;
      options.sessionReloadRequestId.value += 1;
      options.clearSessionCache();
      options.invalidateMessageCacheContext();
    },
    { flush: 'sync' },
  );
}
