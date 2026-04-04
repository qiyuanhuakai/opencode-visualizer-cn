import { useI18n } from 'vue-i18n';
import type { ComputedRef, Ref } from 'vue';
import PermissionContent from '../components/ToolWindow/Permission.vue';
import * as opencodeApi from '../utils/opencode';
import type { useFloatingWindows } from './useFloatingWindows';
import { useDialogHandler } from './useDialogHandler';

export type PermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: {
    messageID: string;
    callID: string;
  };
};

export type PermissionReply = 'once' | 'always' | 'reject';

const PERMISSION_WINDOW_WIDTH = 760;
const PERMISSION_WINDOW_HEIGHT = 340;

export function usePermissions(options: {
  fw: ReturnType<typeof useFloatingWindows>;
  allowedSessionIds: ComputedRef<Set<string>>;
  activeDirectory: Ref<string>;
  ensureConnectionReady: (action: string) => boolean;
}) {
  const { t } = useI18n();
  const dialog = useDialogHandler<PermissionRequest>({
    fw: options.fw,
    allowedSessionIds: options.allowedSessionIds,
    kind: 'permission',
  });

  const { handleReply } = dialog.makeReplyFlow({
    ensureConnectionReady: options.ensureConnectionReady,
    activeDirectory: options.activeDirectory,
    actionKey: 'app.actions.permissionReply',
    sendReply: (requestId, reply) =>
      opencodeApi.replyPermission(requestId, {
        directory: options.activeDirectory.value.trim() || undefined,
        reply: reply as PermissionReply,
      }),
  });

  function parsePermissionRequest(
    value: unknown,
    fallbackSessionId?: string,
  ): PermissionRequest | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const id =
      (typeof record.id === 'string' && record.id) ||
      (typeof record.permissionID === 'string' && record.permissionID) ||
      (typeof record.requestID === 'string' && record.requestID)
        ? String(record.id ?? record.permissionID ?? record.requestID)
        : undefined;
    const sessionID =
      (typeof record.sessionID === 'string' && record.sessionID) ||
      (typeof record.sessionId === 'string' && record.sessionId) ||
      (typeof record.session_id === 'string' && record.session_id) ||
      fallbackSessionId;
    const permission =
      (typeof record.permission === 'string' && record.permission) ||
      (typeof record.type === 'string' && record.type) ||
      (typeof record.title === 'string' && record.title)
        ? String(record.permission ?? record.type ?? record.title)
        : undefined;
    const patterns: string[] = [];
    if (Array.isArray(record.patterns)) {
      patterns.push(...record.patterns.filter((entry) => typeof entry === 'string'));
    }
    const patternValue = record.pattern;
    if (typeof patternValue === 'string') {
      patterns.push(patternValue);
    } else if (Array.isArray(patternValue)) {
      patterns.push(...patternValue.filter((entry) => typeof entry === 'string'));
    }
    const always = Array.isArray(record.always)
      ? record.always.filter((entry) => typeof entry === 'string')
      : [];
    const metadata =
      record.metadata && typeof record.metadata === 'object'
        ? (record.metadata as Record<string, unknown>)
        : {};
    const toolRaw =
      record.tool && typeof record.tool === 'object'
        ? (record.tool as Record<string, unknown>)
        : null;
    const toolMessageId =
      (typeof record.messageID === 'string' && record.messageID) ||
      (toolRaw && typeof toolRaw.messageID === 'string' ? toolRaw.messageID : undefined);
    const toolCallId =
      (typeof record.callID === 'string' && record.callID) ||
      (typeof record.callId === 'string' && record.callId) ||
      (toolRaw && typeof toolRaw.callID === 'string' ? toolRaw.callID : undefined);
    if (!id || !sessionID || !permission) return null;
    const tool =
      toolMessageId && toolCallId ? { messageID: toolMessageId, callID: toolCallId } : undefined;
    return {
      id,
      sessionID,
      permission,
      patterns,
      metadata,
      always,
      tool,
    };
  }

  function upsertPermissionEntry(request: PermissionRequest) {
    dialog.upsert(request, {
      component: PermissionContent,
      props: { onReply: handlePermissionReply },
      title: t('app.windowTitles.permission', { title: request.permission || 'request' }),
      width: PERMISSION_WINDOW_WIDTH,
      height: PERMISSION_WINDOW_HEIGHT,
      color: '#f59e0b',
    });
  }

  function removePermissionEntry(requestId: string) {
    dialog.remove(requestId);
  }

  function prunePermissionEntries() {
    dialog.prune();
  }

  function isPermissionSessionAllowed(request: PermissionRequest): boolean {
    return dialog.isSessionAllowed(request);
  }

  async function fetchPendingPermissions(directory?: string) {
    try {
      const data = await opencodeApi.listPendingPermissions(directory);
      if (!Array.isArray(data)) return;
      data
        .map((entry) => parsePermissionRequest(entry))
        .filter((entry): entry is PermissionRequest => Boolean(entry))
        .filter((entry) => isPermissionSessionAllowed(entry))
        .forEach((entry) => {
          upsertPermissionEntry(entry);
        });
    } catch {}
  }

  async function handlePermissionReply(payload: { requestId: string; reply: PermissionReply }) {
    await handleReply(payload.requestId, payload.reply);
  }

  return {
    parsePermissionRequest,
    upsertPermissionEntry,
    removePermissionEntry,
    prunePermissionEntries,
    handlePermissionReply,
    isPermissionSessionAllowed,
    fetchPendingPermissions,
  };
}
