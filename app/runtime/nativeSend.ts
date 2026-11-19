import { requireValue, type JsonValue } from '../../shared/runtime/capabilities.js';
import type { HarnessKind } from '../../shared/runtime/harnessContract.js';
import type { RuntimeSendInput } from '../composables/useRuntimeSessionActions';

function attachmentObject(value: JsonValue): Readonly<Record<string, JsonValue>> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'attachment.object');
  return Object.fromEntries(Object.entries(value));
}

export function nativeSendArgs(kind: HarnessKind, input: RuntimeSendInput): Readonly<Record<string, JsonValue>> {
  const text = input.text ?? '';
  const model = input.model?.includes('/') ? input.model.slice(input.model.indexOf('/') + 1) : input.model;
  const attachments = input.attachments ?? [];
  const content: JsonValue[] = text ? [{ type: 'text', text }] : [];
  switch (kind) {
    case 'codex': {
      for (const attachment of attachments) {
        const value = attachmentObject(attachment);
        requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'attachment.object');
        const url = value.dataUrl ?? value.url;
        requireValue(typeof url === 'string', 'attachment.url');
        content.push({ type: 'image', url });
      }
      const native: Record<string, JsonValue> = { input: content, ...input.args };
      if (model) native.model = model;
      if (input.mode && model && ['plan', 'default'].includes(input.mode)) native.collaborationMode = { mode: input.mode, settings: { model, developer_instructions: null } };
      if (input.thinking) native.effort = input.thinking;
      return { native, ...(input.queue ? { queue: true } : {}) };
    }
    case 'opencode': {
      for (const attachment of attachments) {
        const value = attachmentObject(attachment);
        requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'attachment.object');
        content.push({ type: 'file', mime: value.mime ?? 'application/octet-stream', url: value.dataUrl ?? value.url ?? '', filename: value.filename ?? '' });
      }
      const body: Record<string, JsonValue> = { parts: content, ...input.args };
      if (input.mode) body.agent = input.mode;
      if (input.model) {
        const separator = input.model.indexOf('/');
        body.model = separator < 0 ? { modelID: input.model } : { providerID: input.model.slice(0, separator), modelID: input.model.slice(separator + 1) };
      }
      if (input.thinking) body.variant = input.thinking;
      return { body };
    }
    case 'acp': {
      for (const attachment of attachments) {
        const value = attachmentObject(attachment);
        requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'attachment.object');
        const url = value.dataUrl;
        requireValue(typeof url === 'string' && url.startsWith('data:'), 'attachment.data');
        content.push({ type: 'image', mimeType: value.mime ?? 'image/png', data: url.slice(url.indexOf(',') + 1) });
      }
      return { prompt: content };
    }
    case 'kimi-web': {
      for (const attachment of attachments) {
        const value = attachmentObject(attachment);
        const url = value.dataUrl;
        requireValue(typeof url === 'string' && url.startsWith('data:') && typeof value.mime === 'string' && value.mime.startsWith('image/'), 'attachment.kimi_image');
        content.push({ type: 'image', source: { kind: 'base64', media_type: value.mime, data: url.slice(url.indexOf(',') + 1) }, ...(typeof value.filename === 'string' ? { name: value.filename } : {}) });
      }
      return { content, ...(model ? { model } : {}), ...input.args };
    }
    case 'dsh': {
      for (const attachment of attachments) {
        const value = attachmentObject(attachment);
        if (typeof value.receiptId === 'string') content.push({ type: 'file', receiptId: value.receiptId });
        else {
          const url = value.dataUrl;
          requireValue(typeof url === 'string' && url.startsWith('data:') && typeof value.mime === 'string' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value.mime), 'attachment.dsh_image');
          content.push({ type: 'image', mediaType: value.mime, data: url.slice(url.indexOf(',') + 1), ...(typeof value.filename === 'string' ? { name: value.filename } : {}) });
        }
      }
      return { request: { content, requestId: crypto.randomUUID(), mode: input.queue ? 'queue' : 'steer', ...input.args } };
    }
  }
}
