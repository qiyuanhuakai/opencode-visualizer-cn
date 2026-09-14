import type { Ref } from 'vue';
import type { BackendKind } from '../backends/types';
import { cloneNullPrototypeRecord } from '../utils/historyMaps';

export type UserMessageMeta = {
  readonly agent?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly variant?: string;
};

type HistoryOwnership = {
  readonly isSubagentMessage: boolean;
  readonly rootRequestId?: number;
  readonly rootSessionId?: string;
};

type RootHistoryLoaderOptions = {
  readonly selectedSessionId: Ref<string>;
  readonly activeBackendKind: Ref<BackendKind>;
  readonly userMessageMetaById: Ref<Record<string, UserMessageMeta>>;
  readonly userMessageTimeById: Ref<Record<string, number>>;
  readonly getSelectedDirectory: () => string;
  readonly listSessionMessages: (
    sessionId: string,
    options: { readonly directory?: string },
  ) => Promise<unknown>;
  readonly loadHistoryIncrementally: (
    entries: unknown[],
    options: { readonly shouldContinue: () => boolean },
  ) => Promise<void>;
  readonly refreshAcpMetadata: () => Promise<void>;
  readonly log: (message: string, error: unknown) => void;
};

function parseMessageTime(info: Record<string, unknown>): number | undefined {
  const time = info.time;
  if (!time || typeof time !== 'object') return undefined;
  const created = Reflect.get(time, 'created');
  return typeof created === 'number' ? created : undefined;
}

function parseUserMessageMeta(info: Record<string, unknown>): UserMessageMeta | null {
  const agent = typeof info.agent === 'string' ? info.agent.trim() : '';
  const model = info.model && typeof info.model === 'object' ? info.model : undefined;
  const nestedProviderId = model ? Reflect.get(model, 'providerID') : undefined;
  const nestedModelId = model ? Reflect.get(model, 'modelID') : undefined;
  const nestedVariant = model ? Reflect.get(model, 'variant') : undefined;
  const providerId =
    typeof info.providerID === 'string'
      ? info.providerID.trim()
      : typeof nestedProviderId === 'string'
        ? nestedProviderId.trim()
        : '';
  const modelId =
    typeof info.modelID === 'string'
      ? info.modelID.trim()
      : typeof nestedModelId === 'string'
        ? nestedModelId.trim()
        : '';
  const variant =
    typeof nestedVariant === 'string'
      ? nestedVariant.trim()
      : typeof info.variant === 'string'
        ? info.variant.trim()
        : '';
  if (!agent && !modelId && !providerId && !variant) return null;
  return {
    agent: agent || undefined,
    providerId: providerId || undefined,
    modelId: modelId || undefined,
    variant: variant || undefined,
  };
}

export function useRootHistoryLoader(options: RootHistoryLoaderOptions) {
  let primaryRequestId = 0;

  function currentRootRequestId() {
    return primaryRequestId;
  }

  function reserveRootHistoryRequestId() {
    primaryRequestId += 1;
    return primaryRequestId;
  }

  function ownsRequest(requestId: number, rootSessionId: string, directory: string) {
    return (
      requestId === primaryRequestId &&
      options.selectedSessionId.value === rootSessionId &&
      options.getSelectedDirectory() === directory
    );
  }

  async function fetchHistory(sessionId: string, ownership?: HistoryOwnership): Promise<boolean> {
    if (!sessionId) return false;
    const isSubagentMessage = ownership?.isSubagentMessage ?? false;
    const requestId = isSubagentMessage
      ? (ownership?.rootRequestId ?? 0)
      : reserveRootHistoryRequestId();
    const rootSessionId = ownership?.rootSessionId ?? sessionId;
    const directory = options.getSelectedDirectory();
    try {
      const data = await options.listSessionMessages(sessionId, {
        directory: directory || undefined,
      });
      if (options.activeBackendKind.value === 'acp') await options.refreshAcpMetadata();
      if (!Array.isArray(data) || !ownsRequest(requestId, rootSessionId, directory)) return false;

      await options.loadHistoryIncrementally(data, {
        shouldContinue: () => ownsRequest(requestId, rootSessionId, directory),
      });
      if (!ownsRequest(requestId, rootSessionId, directory)) return false;

      const nextMeta = cloneNullPrototypeRecord(options.userMessageMetaById.value);
      const nextTime = cloneNullPrototypeRecord(options.userMessageTimeById.value);
      data.forEach((message) => {
        if (!message || typeof message !== 'object') return;
        const info = Reflect.get(message, 'info');
        if (!info || typeof info !== 'object') return;
        const id = Reflect.get(info, 'id');
        if (typeof id !== 'string') return;
        const meta = parseUserMessageMeta(info);
        const messageTime = parseMessageTime(info);
        if (meta) nextMeta[id] = meta;
        if (typeof messageTime === 'number') nextTime[id] = messageTime;
      });
      options.userMessageMetaById.value = nextMeta;
      options.userMessageTimeById.value = nextTime;
      return true;
    } catch (error) {
      options.log('History load failed', error);
      return false;
    }
  }

  async function fetchRootSessionHistory(rootSessionId: string) {
    const loaded = await fetchHistory(rootSessionId);
    return { requestId: primaryRequestId, loaded };
  }

  return {
    currentRootRequestId,
    reserveRootHistoryRequestId,
    fetchHistory,
    fetchRootSessionHistory,
  };
}
