/**
 * Kimi Web send path: content-part construction, attachment upload, steer and
 * abort. It runs behind the shared `useBackendMessageSend` preflight and
 * request fence; every awaited step re-checks the guard so an obsolete
 * response can never mutate active state.
 */
import type {
  BackendMessageSendParams,
  RequestGuard,
  SendPreflight,
} from '../../composables/backendMessageSend.types';
import type { ComposerAttachment } from '../../types/composer';
import type {
  KimiWebClient,
  KimiWebContentPart,
  KimiWebPromptAccepted,
  KimiWebUploadedFile,
} from '../../utils/kimiWeb';
import { KimiWebTransportError } from '../../utils/kimiWeb';

/** REST surface the send path needs; Todo 25 passes the real client. */
export type KimiWebSendApi = Pick<
  KimiWebClient,
  'sendPrompt' | 'uploadFile' | 'steer' | 'abortPrompt'
>;

/** Todo 9 WS client subset used for the abort frame. */
export type KimiWebAbortChannel = {
  abort(sessionId: string, promptId: string): Promise<unknown>;
  isConnected?(): boolean;
};

export type KimiWebPromptStatus = 'running' | 'queued' | 'blocked';

export type KimiWebSendExecutionResult =
  | { readonly kind: 'stale' }
  | {
      readonly kind: 'accepted';
      readonly promptId: string;
      readonly userMessageId: string;
      readonly status: KimiWebPromptStatus;
    };

export type KimiWebSteerResult =
  | { readonly kind: 'steered'; readonly promptIds: readonly string[] }
  | { readonly kind: 'stale' };

export type KimiWebAbortResult =
  | { readonly kind: 'aborted'; readonly transport: 'ws' | 'rest'; readonly atSeq?: number }
  | { readonly kind: 'stale' };

const DATA_URL_RE = /^data:([^;,]*)(;base64)?,(.*)$/su;

function refusePendingModeSend(
  params: BackendMessageSendParams,
  preflight: SendPreflight,
): KimiWebSendExecutionResult {
  if (!params.messageInput.value) params.messageInput.value = preflight.text;
  params.persistComposerDraftForCurrentContext();
  return { kind: 'stale' };
}

function decodeAttachmentBlob(attachment: ComposerAttachment): Blob {
  const match = DATA_URL_RE.exec(attachment.dataUrl);
  if (!match) {
    throw new KimiWebTransportError(
      `Attachment "${attachment.filename}" is not a data URL and cannot be uploaded.`,
      { kind: 'malformed-response', path: '/api/v1/files' },
    );
  }
  const mediaType = match[1] || 'application/octet-stream';
  const payload = match[3] ?? '';
  const bytes = match[2]
    ? Uint8Array.from(atob(payload), (character) => character.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(payload));
  return new Blob([bytes], { type: mediaType });
}

export async function uploadKimiWebAttachment(
  api: KimiWebSendApi,
  attachment: ComposerAttachment,
): Promise<KimiWebUploadedFile> {
  return api.uploadFile({
    file: decodeAttachmentBlob(attachment),
    name: attachment.filename,
  });
}

export async function buildKimiWebContentParts(
  params: BackendMessageSendParams,
  preflight: SendPreflight,
  guard: RequestGuard,
  api: KimiWebSendApi,
): Promise<KimiWebContentPart[] | null> {
  const parts: KimiWebContentPart[] = [];
  const messageText = preflight.transformText(preflight.text);
  if (preflight.hasText && messageText) parts.push({ type: 'text', text: messageText });
  for (const item of preflight.attachments) {
    if (!guard.isCurrent()) return null;
    if (item.lineComment) {
      // An editor selection has no bytes to upload: the formatted note
      // (path + range + comment) carries the reference, mirroring Codex.
      parts.push({
        type: 'text',
        text: params.formatCommentNote(
          item.lineComment.path,
          item.lineComment.startLine,
          item.lineComment.endLine,
          item.lineComment.text,
        ),
      });
      continue;
    }
    const uploaded = await uploadKimiWebAttachment(api, item);
    if (!guard.isCurrent()) return null;
    if (item.mime.startsWith('image/')) {
      parts.push({
        type: 'image',
        source: { kind: 'file', file_id: uploaded.id },
        name: uploaded.name,
      });
    } else {
      parts.push({
        type: 'file',
        file_id: uploaded.id,
        name: uploaded.name,
        media_type: uploaded.media_type,
        size: uploaded.size,
      });
    }
  }
  return parts;
}

export async function runKimiWebSend(
  params: BackendMessageSendParams,
  preflight: SendPreflight,
  guard: RequestGuard,
  api: KimiWebSendApi,
): Promise<KimiWebSendExecutionResult> {
  if (!guard.isCurrent()) return { kind: 'stale' };
  if (params.isKimiWebSessionModeReady?.(preflight.sessionId) === false) {
    return refusePendingModeSend(params, preflight);
  }
  const parts = await buildKimiWebContentParts(params, preflight, guard, api);
  if (!parts || !guard.isCurrent()) return { kind: 'stale' };
  if (params.isKimiWebSessionModeReady?.(preflight.sessionId) === false) {
    return refusePendingModeSend(params, preflight);
  }
  const accepted: KimiWebPromptAccepted = await api.sendPrompt(preflight.sessionId, {
    content: parts,
  });
  if (!guard.isCurrent()) return { kind: 'stale' };
  return {
    kind: 'accepted',
    promptId: accepted.prompt_id,
    userMessageId: accepted.user_message_id,
    status: accepted.status,
  };
}

export async function steerKimiWebPrompts(options: {
  readonly api: KimiWebSendApi;
  readonly sessionId: string;
  readonly promptIds: readonly string[];
  readonly guard?: RequestGuard;
}): Promise<KimiWebSteerResult> {
  const { api, sessionId, promptIds, guard } = options;
  if (guard && !guard.isCurrent()) return { kind: 'stale' };
  const result = await api.steer(sessionId, [...promptIds]);
  if (guard && !guard.isCurrent()) return { kind: 'stale' };
  return { kind: 'steered', promptIds: result.prompt_ids };
}

export async function abortKimiWebPrompt(options: {
  readonly api: KimiWebSendApi;
  readonly channel?: KimiWebAbortChannel;
  readonly sessionId: string;
  readonly promptId: string;
  readonly guard?: RequestGuard;
}): Promise<KimiWebAbortResult> {
  const { api, channel, sessionId, promptId, guard } = options;
  if (guard && !guard.isCurrent()) return { kind: 'stale' };
  const socketReady = channel !== undefined && (channel.isConnected?.() ?? true);
  if (socketReady) {
    try {
      await channel.abort(sessionId, promptId);
      if (guard && !guard.isCurrent()) return { kind: 'stale' };
      return { kind: 'aborted', transport: 'ws' };
    } catch {
      // WS abort is best-effort; fall through to the REST prompt-abort tail.
    }
  }
  const result = await api.abortPrompt(sessionId, promptId);
  if (guard && !guard.isCurrent()) return { kind: 'stale' };
  return { kind: 'aborted', transport: 'rest', atSeq: result.at_seq };
}
