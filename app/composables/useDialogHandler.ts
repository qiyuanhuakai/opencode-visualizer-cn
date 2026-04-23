import { ref } from 'vue';
import type { ComputedRef, Ref, Component } from 'vue';
import type { useFloatingWindows } from './useFloatingWindows';

export type DialogRequestBase = {
  id: string;
  sessionID: string;
};

export type DialogWindowOptions = {
  component: Component;
  props: Record<string, unknown>;
  title: string;
  width: number;
  height: number;
  color?: string;
  resizable?: boolean;
  scroll?: 'manual' | 'follow';
};

export function useDialogHandler<R extends DialogRequestBase>(options: {
  fw: ReturnType<typeof useFloatingWindows>;
  allowedSessionIds: ComputedRef<Set<string>>;
  kind: string;
}) {
  const sendingById = ref<Record<string, boolean>>({});
  const errorById = ref<Record<string, string>>({});

  const getKey = (requestId: string) => `${options.kind}:${requestId}`;

  function setSending(requestId: string, value: boolean) {
    const next = { ...sendingById.value };
    if (value) next[requestId] = true;
    else delete next[requestId];
    sendingById.value = next;
  }

  function clearSending(requestId: string) {
    setSending(requestId, false);
  }

  function setError(requestId: string, message: string) {
    const next = { ...errorById.value };
    if (message) next[requestId] = message;
    else delete next[requestId];
    errorById.value = next;
  }

  function clearError(requestId: string) {
    setError(requestId, '');
  }

  function isSubmitting(requestId: string): boolean {
    return Boolean(sendingById.value[requestId]);
  }

  function getError(requestId: string): string {
    return errorById.value[requestId] ?? '';
  }

  function isSessionAllowed(request: R): boolean {
    const allowed = options.allowedSessionIds.value;
    if (!request.sessionID) return false;
    if (allowed.size === 0) return false;
    return allowed.has(request.sessionID);
  }

  function upsert(request: R, windowOptions: DialogWindowOptions) {
    const key = getKey(request.id);
    options.fw.open(key, {
      component: windowOptions.component,
      props: {
        ...windowOptions.props,
        request,
        isSubmitting: isSubmitting(request.id),
        error: getError(request.id),
      },
      closable: false,
      resizable: windowOptions.resizable ?? false,
      scroll: windowOptions.scroll ?? 'manual',
      color: windowOptions.color,
      title: windowOptions.title,
      width: windowOptions.width,
      height: windowOptions.height,
      expiry: Infinity,
    });
  }

  function refresh(requestId: string, buildProps: (request: R) => Record<string, unknown>) {
    const key = getKey(requestId);
    const entry = options.fw.get(key);
    if (!entry) return;
    const request = entry.props?.request as R | undefined;
    if (!request) return;
    options.fw.updateOptions(key, {
      props: {
        ...buildProps(request),
        request,
        isSubmitting: isSubmitting(requestId),
        error: getError(requestId),
      },
    });
  }

  function remove(requestId: string) {
    options.fw.close(getKey(requestId));
    clearSending(requestId);
    clearError(requestId);
  }

  function prune() {
    const allowed = options.allowedSessionIds.value;
    for (const entry of options.fw.entries.value) {
      if (!entry.key.startsWith(`${options.kind}:`)) continue;
      const request = entry.props?.request as R | undefined;
      if (!request) continue;
      if (!allowed.has(request.sessionID)) {
        remove(request.id);
      }
    }
  }

  function makeReplyFlow(props: {
    ensureConnectionReady: (action: string) => boolean;
    activeDirectory: Ref<string>;
    actionKey: string;
    sendReply: (requestId: string, payload: unknown) => Promise<void>;
  }) {
    async function handleReply(requestId: string, payload: unknown) {
      if (!props.ensureConnectionReady(props.actionKey)) return;
      if (isSubmitting(requestId)) return;
      clearError(requestId);
      setSending(requestId, true);
      refresh(requestId, () => ({}));
      try {
        await props.sendReply(requestId, payload);
        remove(requestId);
      } catch (error) {
        setError(requestId, error instanceof Error ? error.message : String(error));
        refresh(requestId, () => ({}));
      } finally {
        clearSending(requestId);
        refresh(requestId, () => ({}));
      }
    }
    return { handleReply };
  }

  function makeRejectFlow(props: {
    ensureConnectionReady: (action: string) => boolean;
    activeDirectory: Ref<string>;
    actionKey: string;
    sendReject: (requestId: string) => Promise<void>;
  }) {
    async function handleReject(requestId: string) {
      if (!props.ensureConnectionReady(props.actionKey)) return;
      if (isSubmitting(requestId)) return;
      clearError(requestId);
      setSending(requestId, true);
      refresh(requestId, () => ({}));
      try {
        await props.sendReject(requestId);
        remove(requestId);
      } catch (error) {
        setError(requestId, error instanceof Error ? error.message : String(error));
        refresh(requestId, () => ({}));
      } finally {
        clearSending(requestId);
        refresh(requestId, () => ({}));
      }
    }
    return { handleReject };
  }

  return {
    isSubmitting,
    getError,
    isSessionAllowed,
    setSending,
    clearSending,
    setError,
    clearError,
    upsert,
    refresh,
    remove,
    prune,
    makeReplyFlow,
    makeRejectFlow,
  };
}
