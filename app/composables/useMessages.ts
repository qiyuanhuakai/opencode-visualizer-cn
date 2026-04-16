import { computed, readonly, shallowRef, triggerRef } from 'vue';
import type { ShallowRef } from 'vue';
import type {
  MessageAttachment,
  MessageDiffEntry,
  MessageStatus,
  MessageUsage,
} from '../types/message';
import type {
  MessageInfo,
  MessagePart,
  MessagePartDeltaPacket,
  MessagePartUpdatedPacket,
  MessageUpdatedPacket,
} from '../types/sse';
import type { SessionScope } from './useGlobalEvents';
import { useDeltaAccumulator } from './useDeltaAccumulator';

type MessageEntry = {
  info?: MessageInfo;
  parts: Set<ShallowRef<MessagePart>>;
};

type MessageError = { name: string; message: string } | null;

// Batched update system
// Instead of triggering ref updates immediately, we queue them and flush
// in the next microtask to reduce re-renders during streaming
const pendingMessageTriggers = new Set<ShallowRef<MessageEntry>>();
const pendingCollectionTrigger = { value: false };
let flushScheduled = false;
const HISTORY_CHUNK_SIZE = 40;

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  
  // Use microtask to batch updates within the same event loop iteration
  queueMicrotask(() => {
    flushScheduled = false;
    
    // Trigger all pending message refs
    for (const ref of pendingMessageTriggers) {
      triggerRef(ref);
    }
    pendingMessageTriggers.clear();
    
    // Trigger collection if needed
    if (pendingCollectionTrigger.value) {
      pendingCollectionTrigger.value = false;
      triggerRef(messages);
    }
  });
}

function triggerMessageRef(ref: ShallowRef<MessageEntry>) {
  pendingMessageTriggers.add(ref);
  scheduleFlush();
}

function triggerCollection() {
  pendingCollectionTrigger.value = true;
  scheduleFlush();
}

function createMessageEntry(): MessageEntry {
  return { parts: new Set<ShallowRef<MessagePart>>() };
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isMessageInfo(value: unknown): value is MessageInfo {
  const rec = toRecord(value);
  if (!rec) return false;
  if (!asString(rec.id)) return false;
  if (!asString(rec.sessionID)) return false;
  return rec.role === 'user' || rec.role === 'assistant';
}

function isMessagePart(value: unknown): value is MessagePart {
  const rec = toRecord(value);
  if (!rec) return false;
  if (!asString(rec.id)) return false;
  if (!asString(rec.sessionID)) return false;
  if (!asString(rec.messageID)) return false;
  return typeof rec.type === 'string';
}

function normalizeTokens(value: unknown): MessageUsage['tokens'] | undefined {
  const rec = toRecord(value);
  if (!rec) return undefined;
  const input = asNumber(rec.input);
  const output = asNumber(rec.output);
  const reasoning = asNumber(rec.reasoning);
  if (input === undefined || output === undefined || reasoning === undefined) return undefined;
  const total = asNumber(rec.total);
  const cacheRec = toRecord(rec.cache);
  const cacheRead = asNumber(cacheRec?.read);
  const cacheWrite = asNumber(cacheRec?.write);
  return {
    input,
    output,
    reasoning,
    total,
    cache:
      cacheRead === undefined || cacheWrite === undefined
        ? undefined
        : { read: cacheRead, write: cacheWrite },
  };
}

function getProviderId(info?: MessageInfo): string | undefined {
  if (!info) return undefined;
  return info.role === 'assistant' ? asString(info.providerID) : asString(info.model.providerID);
}

function getModelId(info?: MessageInfo): string | undefined {
  if (!info) return undefined;
  return info.role === 'assistant' ? asString(info.modelID) : asString(info.model.modelID);
}

function normalizeUsage(info?: MessageInfo): MessageUsage | undefined {
  if (!info || info.role !== 'assistant') return undefined;
  const tokens = normalizeTokens(info.tokens);
  if (!tokens) return undefined;
  return {
    tokens,
    cost: asNumber(info.cost),
    providerId: getProviderId(info),
    modelId: getModelId(info),
  };
}

function resolveStatus(info?: MessageInfo): MessageStatus {
  if (!info) return 'streaming';
  if (info.role === 'user') return 'complete';
  if (info.error || info.finish === 'error') return 'error';
  if (info.time.completed !== undefined || info.finish) return 'complete';
  return 'streaming';
}

function resolveError(info?: MessageInfo): MessageError {
  const status = resolveStatus(info);
  if (!info || info.role !== 'assistant') return null;
  if (!info.error) return status === 'error' ? { name: 'Error', message: '' } : null;
  const message = asString(toRecord(info.error.data)?.message) ?? '';
  return { name: info.error.name, message };
}

function byTimeThenId(a: MessageInfo, b: MessageInfo): number {
  const aTime = asNumber(a.time.created) ?? 0;
  const bTime = asNumber(b.time.created) ?? 0;
  if (aTime !== bTime) return aTime - bTime;
  return a.id.localeCompare(b.id);
}

// Module-level singleton state
const acc = useDeltaAccumulator();
const messages = shallowRef(new Map<string, ShallowRef<MessageEntry>>());
const parts = new Map<string, ShallowRef<MessagePart>>();

const roots = computed(() => {
  const result: MessageInfo[] = [];
  for (const messageRef of messages.value.values()) {
    const info = messageRef.value.info;
    if (!info) continue;
    if (info.role === 'user') {
      result.push(info);
      continue;
    }
    const parent = messages.value.get(info.parentID)?.value.info;
    if (!parent) result.push(info);
  }
  return result.sort(byTimeThenId);
});

const streaming = computed(() => {
  const result: MessageInfo[] = [];
  for (const messageRef of messages.value.values()) {
    const info = messageRef.value.info;
    if (!info) continue;
    if (resolveStatus(info) !== 'streaming') continue;
    result.push(info);
  }
  return result.sort(byTimeThenId);
});

const childrenByParent = computed(() => {
  const index = new Map<string, MessageInfo[]>();
  for (const messageRef of messages.value.values()) {
    const info = messageRef.value.info;
    if (!info || info.role !== 'assistant') continue;
    let list = index.get(info.parentID);
    if (!list) {
      list = [];
      index.set(info.parentID, list);
    }
    list.push(info);
  }
  for (const list of index.values()) {
    list.sort(byTimeThenId);
  }
  return index;
});

function ensureMessage(id: string, notifyCollection = true): ShallowRef<MessageEntry> {
  let ref = messages.value.get(id);
  if (ref) return ref;
  ref = shallowRef(createMessageEntry());
  messages.value.set(id, ref);
  if (notifyCollection) triggerCollection();
  return ref;
}

function partLookupKey(messageId: string, partId: string): string {
  return `${messageId}:${partId}`;
}

function updateMessage(info: MessageInfo, notifyCollection = true) {
  const messageRef = ensureMessage(info.id, notifyCollection);
  messageRef.value.info = info;
  triggerMessageRef(messageRef);
}

function updatePart(part: MessagePart, notifyCollection = true) {
  const key = partLookupKey(part.messageID, part.id);
  const existing = parts.get(key);
  if (existing) {
    existing.value = part;
    triggerRef(existing);
    return;
  }
  const partRef = shallowRef(part);
  parts.set(key, partRef);
  const messageRef = ensureMessage(part.messageID, notifyCollection);
  messageRef.value.parts.add(partRef);
  triggerMessageRef(messageRef);
}

const unsubs: Array<() => void> = [];

function bindScope(scope: SessionScope) {
  for (const unsub of unsubs) unsub();
  unsubs.length = 0;

  unsubs.push(
    scope.on('message.part.updated', (packet: MessagePartUpdatedPacket) => {
      updatePart(packet.part);
    }),
    scope.on('message.part.delta', (packet: MessagePartDeltaPacket) => {
      const accumulated = acc.getMessage(packet.messageID);
      const accPart = accumulated?.parts.get(packet.partID);
      if (!accPart) return;
      const key = partLookupKey(packet.messageID, packet.partID);
      const partRef = parts.get(key);
      if (!partRef) return;
      partRef.value = accPart;
      triggerRef(partRef);
    }),
    scope.on('message.updated', (packet: MessageUpdatedPacket) => {
      updateMessage(packet.info);
    }),
  );
}

function get(id: string): MessageInfo | undefined {
  return messages.value.get(id)?.value.info;
}

function getParts(id: string): MessagePart[] {
  const messageRef = messages.value.get(id);
  if (!messageRef) return [];
  const result: MessagePart[] = [];
  for (const partRef of messageRef.value.parts) {
    result.push(partRef.value);
  }
  return result;
}

function getPartsByType<T extends MessagePart['type']>(
  id: string,
  type: T,
): Array<Extract<MessagePart, { type: T }>> {
  const result: Array<Extract<MessagePart, { type: T }>> = [];
  const messageRef = messages.value.get(id);
  if (!messageRef) return result;
  for (const partRef of messageRef.value.parts) {
    const part = partRef.value;
    if (part.type !== type) continue;
    result.push(part as Extract<MessagePart, { type: T }>);
  }
  return result;
}

function hasTextContent(id: string): boolean {
  const messageRef = messages.value.get(id);
  if (!messageRef) return false;
  for (const partRef of messageRef.value.parts) {
    const part = partRef.value;
    if (part.type === 'text' && part.text) return true;
  }
  return false;
}

function getTextContent(id: string): string {
  const chunks: string[] = [];
  const textParts = getPartsByType(id, 'text');
  for (const part of textParts) {
    if (!part.text) continue;
    chunks.push(part.text);
  }
  return chunks.join('');
}

function getImageAttachments(id: string): MessageAttachment[] | undefined {
  const files = getPartsByType(id, 'file');
  if (files.length === 0) return undefined;
  const result: MessageAttachment[] = [];
  let index = 0;
  for (const part of files) {
    if (!part.mime.startsWith('image/')) continue;
    result.push({
      id: part.id,
      url: part.url,
      mime: part.mime,
      filename: part.filename ?? `attachment-${index + 1}`,
    });
    index += 1;
  }
  return result.length > 0 ? result : undefined;
}

function getUsage(id: string): MessageUsage | undefined {
  return normalizeUsage(get(id));
}

function getStatus(id: string): MessageStatus {
  return resolveStatus(get(id));
}

function getError(id: string): MessageError {
  return resolveError(get(id));
}

function getDiffs(id: string): MessageDiffEntry[] | undefined {
  const info = get(id);
  if (!info || info.role !== 'user' || !Array.isArray(info.summary?.diffs)) return undefined;
  const result: MessageDiffEntry[] = [];
  for (const diff of info.summary.diffs) {
    if (!diff.file) continue;
    result.push({
      file: diff.file,
      diff: diff.patch ?? '',
      before: diff.before,
      after: diff.after,
    });
  }
  return result.length > 0 ? result : undefined;
}

function getModelPath(id: string): string | undefined {
  const info = get(id);
  if (!info) return undefined;
  const providerId = getProviderId(info);
  const modelId = getModelId(info);
  if (providerId && modelId) return `${providerId}/${modelId}`;
  return modelId || providerId;
}

function getTime(id: string): number | undefined {
  const info = get(id);
  if (!info) return undefined;
  return asNumber(info.time.created);
}

function getCompletedTime(id: string): number | undefined {
  const info = get(id);
  if (!info) return undefined;
  if (info.role === 'assistant')
    return asNumber(info.time.completed) ?? asNumber(info.time.created);
  return asNumber(info.time.created);
}

function getChildren(parentId: string): MessageInfo[] {
  return childrenByParent.value.get(parentId) ?? [];
}

function getThread(rootId: string): MessageInfo[] {
  const root = get(rootId);
  if (!root) return [];
  const result: MessageInfo[] = [];
  const queue: string[] = [rootId];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const info = get(current);
    if (!info) continue;
    result.push(info);
    const children = getChildren(current);
    for (const child of children) queue.push(child.id);
  }
  return result.sort(byTimeThenId);
}

function getFinalAnswer(rootId: string): MessageInfo | undefined {
  const thread = getThread(rootId);
  const assistants = thread
    .filter((message) => message.role === 'assistant' && hasTextContent(message.id))
    .sort(byTimeThenId);
  return assistants[assistants.length - 1];
}

function loadHistory(entries: unknown[]) {
  let collectionChanged = false;
  for (const entry of entries) {
    const rec = toRecord(entry);
    if (!rec) continue;
    const info = rec.info;
    const partsList = rec.parts;
    if (!isMessageInfo(info)) continue;
    const accumulated = acc.getMessage(info.id);
    const hasMessage = messages.value.has(info.id);
    const messageRef = ensureMessage(info.id, false);
    if (!hasMessage) collectionChanged = true;
    if (!messageRef.value.info) {
      messageRef.value.info = accumulated?.info ?? info;
      triggerMessageRef(messageRef);
    }
    if (!Array.isArray(partsList)) continue;
    let addedPart = false;
    for (const item of partsList) {
      if (!isMessagePart(item)) continue;
      const merged = accumulated?.parts.get(item.id) ?? item;
      const key = partLookupKey(merged.messageID, merged.id);
      if (parts.has(key)) continue;
      const partRef = shallowRef(merged);
      parts.set(key, partRef);
      messageRef.value.parts.add(partRef);
      addedPart = true;
    }
    if (accumulated) {
      for (const [partId, accPart] of accumulated.parts) {
        const key = partLookupKey(accPart.messageID, partId);
        if (parts.has(key)) continue;
        const partRef = shallowRef(accPart);
        parts.set(key, partRef);
        messageRef.value.parts.add(partRef);
        addedPart = true;
      }
    }
    if (addedPart) triggerMessageRef(messageRef);
  }
  if (collectionChanged) triggerCollection();
}

async function loadHistoryIncrementally(
  entries: unknown[],
  options?: {
    chunkSize?: number;
    shouldContinue?: () => boolean;
  },
) {
  const chunkSize = Math.max(1, options?.chunkSize ?? HISTORY_CHUNK_SIZE);
  for (let offset = 0; offset < entries.length; offset += chunkSize) {
    if (options?.shouldContinue && !options.shouldContinue()) return;
    loadHistory(entries.slice(offset, offset + chunkSize));
    if (offset + chunkSize < entries.length) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  }
}

function reset() {
  messages.value.clear();
  parts.clear();
  triggerCollection();
}

function dispose() {
  for (const unsub of unsubs) unsub();
}

export function useMessages() {
  return {
    messages: readonly(messages),
    roots,
    streaming,
    get,
    getParts,
    getPartsByType,
    hasTextContent,
    getTextContent,
    getImageAttachments,
    getUsage,
    getStatus,
    getError,
    getDiffs,
    getModelPath,
    getProviderId,
    getModelId,
    getTime,
    getCompletedTime,
    getChildren,
    getThread,
    getFinalAnswer,
    updateMessage,
    updatePart,
    loadHistory,
    loadHistoryIncrementally,
    reset,
    dispose,
    bindScope,
  };
}
