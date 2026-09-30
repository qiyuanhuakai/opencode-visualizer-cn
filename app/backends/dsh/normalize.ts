/**
 * dsh web WS event normalizer (dsh web 0.2.0-rc.2, docs/dsh.md §8).
 *
 * Maps `session/follow` records (`{type:'event',event:{type,seq,time,data}}`)
 * into the existing `MessageInfo`/`MessagePart` shapes without touching the
 * shared contracts. Completion state derives ONLY from `turn/end.reason`;
 * nothing else is a success or failure signal.
 *
 * Dedup is layered, mirroring the replay-boundary contract (task 7) and the
 * kimi L43 lesson:
 *   - seq gate: the snapshot is authoritative full state, so a record whose
 *     seq was already applied emits nothing (R1/R2 — reconnects replay from
 *     seq 0 and must not double-render);
 *   - live vs durable: a durable full message replaces streamed deltas instead
 *     of appending to them;
 *   - unknown/malformed input is counted and ignored, never fatal.
 */
import { AGENT_HANDLERS } from './handlers-agent';
import { CORE_HANDLERS } from './handlers-core';
import { applyLiveAssistantChunk, registerAssistantAttempt, type DshHandler } from './handlers-core';
import { isRecord, asNumber, asString, type DshCore } from './parts';
import type {
  DshNormalizeOp,
  DshNormalizeResult,
  DshNormalizeStats,
  DshNormalizer,
  DshNormalizerOptions,
} from './ops';
import { isDshSessionAddress, type DshSessionAddress, type DshSessionRecord, type DshSessionWireEvent } from './types';

const HANDLERS: Record<string, DshHandler> = { ...CORE_HANDLERS, ...AGENT_HANDLERS };

/** Event types known to the wire but intentionally not mapped to a message. */
const IGNORED_EVENTS = new Set<string>([
  'session/title-llm-request',
  'session/end-seed',
  'tool/ptc-dispatch-start',
  'tool/ptc-dispatch',
  'command/run',
  'command/done',
  'image/offload',
  'todo/write',
  'model/selection',
  'subagent/catalog',
  'compaction/start',
  'compaction/summary',
  'compaction/end',
  'compaction/prune',
  'feedback/record',
  'feedback/message-put',
  'feedback/message-delete',
  'goal/change',
  'schedule/change',
  'agent-preset/selected',
]);

function newStats(): DshNormalizeStats {
  return {
    frames: 0,
    appliedRecordCount: 0,
    duplicateRecordCount: 0,
    duplicateDeltaCount: 0,
    staleDeltaCount: 0,
    ignoredEventCount: 0,
    unknownEventCount: 0,
    malformedCount: 0,
  };
}

function asRecordEvent(value: unknown): DshSessionWireEvent | undefined {
  if (!isRecord(value)) return undefined;
  const event = isRecord(value.event) ? value.event : value;
  if (typeof event.type !== 'string') return undefined;
  if (!Number.isFinite(event.seq)) return undefined;
  return event as unknown as DshSessionWireEvent;
}

/** Unwrap `{type:'item',streamId,value}` down to the follow-frame value. */
function followValueOf(raw: unknown): unknown {
  if (!isRecord(raw)) return undefined;
  if (raw.type === 'item') return followValueOf(raw.value);
  return raw;
}

export function createDshNormalizer(options: DshNormalizerOptions = {}): DshNormalizer {
  const stats = newStats();
  const address: DshSessionAddress | undefined = options.address && isDshSessionAddress(options.address)
    ? options.address
    : undefined;
  const core: DshCore = {
    now: options.now ?? (() => Date.now()),
    stats,
    address,
    // A subagent child session is its own message space: records arriving
    // through the child address belong to the child session id.
    sessionId: address?.kind === 'session'
      ? address.sessionId
      : address?.kind === 'subagent'
        ? address.childSessionId
        : '',
    cursor: -1,
    appliedSeqs: new Set(),
    appliedChunks: new Set(),
    appliedMessages: new Set(),
    sealedGroups: new Set(),
    groups: new Map(),
    toolParts: new Map(),
    model: { providerID: '', modelID: '' },
    agentPreset: '',
    records: [],
    attempts: new Map(),
  };

  function applyEvent(event: DshSessionWireEvent, ops: DshNormalizeOp[]): boolean {
    const handler = HANDLERS[event.type];
    if (handler) {
      handler(core, event, ops);
      return true;
    }
    if (IGNORED_EVENTS.has(event.type)) {
      stats.ignoredEventCount += 1;
      return true;
    }
    stats.unknownEventCount += 1;
    return false;
  }

  function applyRecord(raw: unknown, ops: DshNormalizeOp[]): DshNormalizeResult {
    const event = asRecordEvent(raw);
    if (!event) {
      stats.malformedCount += 1;
      return { eventType: '', duplicate: false, duplicateCount: 0, ops };
    }
    const before = ops.length;
    const wasDuplicate = core.appliedSeqs.has(event.seq);
    if (wasDuplicate) {
      stats.duplicateRecordCount += 1;
    } else {
      core.appliedSeqs.add(event.seq);
      if (event.seq > core.cursor) core.cursor = event.seq;
      stats.appliedRecordCount += 1;
      applyEvent(event, ops);
      if (isRecord(raw) && raw.type === 'event') core.records.push(raw as DshSessionRecord);
    }
    return {
      eventType: event.type,
      duplicate: wasDuplicate,
      duplicateCount: wasDuplicate ? 1 : 0,
      ops: ops.slice(before),
    };
  }

  function ingest(raw: unknown): DshNormalizeResult {
    stats.frames += 1;
    const ops: DshNormalizeOp[] = [];
    let value = raw;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        stats.malformedCount += 1;
        return { eventType: '', duplicate: false, duplicateCount: 0, ops };
      }
    }
    if (!isRecord(value)) {
      stats.malformedCount += 1;
      return { eventType: '', duplicate: false, duplicateCount: 0, ops };
    }

    if (value.type === 'end' || value.type === 'cancel') {
      return { eventType: value.type, duplicate: false, duplicateCount: 0, ops };
    }

    const frame = followValueOf(value);
    if (!isRecord(frame)) {
      stats.malformedCount += 1;
      return { eventType: '', duplicate: false, duplicateCount: 0, ops };
    }

    if (frame.type === 'snapshot') {
      return ingestSnapshot(frame, ops);
    }
    if (frame.type === 'assistant-stream') {
      return ingestAssistantStream(frame, ops);
    }
    if (Array.isArray(frame.records)) {
      // session/page result: raw records with no header of their own.
      let duplicateCount = 0;
      let eventType = '';
      for (const record of frame.records) {
        const result = applyRecord(record, ops);
        duplicateCount += result.duplicateCount;
        if (result.eventType) eventType = result.eventType;
      }
      return { eventType, duplicate: duplicateCount > 0, duplicateCount, ops };
    }
    if (frame.type === 'item' && frame.value === undefined) {
      stats.malformedCount += 1;
      return { eventType: '', duplicate: false, duplicateCount: 0, ops };
    }
    return applyRecord(frame, ops);
  }

  function ingestSnapshot(frame: Record<string, unknown>, ops: DshNormalizeOp[]): DshNormalizeResult {
    const header = isRecord(frame.header) ? frame.header : {};
    const snapshotId = asString(header.id);
    const preset = asString(header.agentPreset);
    if (preset) core.agentPreset = preset;
    if (snapshotId) {
      // A snapshot is authoritative full state: a different session id means a
      // fresh normalizer state, not a merge.
      if (core.sessionId && core.sessionId !== snapshotId) reset();
      core.sessionId = snapshotId;
    }
    const records = Array.isArray(frame.records) ? frame.records : [];
    let duplicateCount = 0;
    for (const record of records) {
      duplicateCount += applyRecord(record, ops).duplicateCount;
    }
    if (asNumber(frame.cursor) !== undefined) core.cursor = Math.max(core.cursor, asNumber(frame.cursor) ?? core.cursor);
    return { eventType: 'snapshot', sessionId: core.sessionId, duplicate: duplicateCount > 0, duplicateCount, ops };
  }

  function ingestAssistantStream(frame: Record<string, unknown>, ops: DshNormalizeOp[]): DshNormalizeResult {
    const entry = isRecord(frame.frame) ? frame.frame : frame;
    const type = asString(entry.type);
    if (type === 'start') {
      const attemptId = asString(entry.attemptId);
      registerAssistantAttempt(core, attemptId, asNumber(entry.turn) ?? 0, asNumber(entry.step) ?? 0);
      return { eventType: 'assistant-stream', duplicate: false, duplicateCount: 0, ops };
    }
    if (type === 'chunk') {
      const before = ops.length;
      applyLiveAssistantChunk(
        core,
        asString(entry.attemptId),
        asNumber(entry.index) ?? 0,
        isRecord(entry.chunk) ? entry.chunk : {},
        asNumber(entry.time) ?? core.now(),
        ops,
      );
      return { eventType: 'assistant-stream', duplicate: false, duplicateCount: 0, ops: ops.slice(before) };
    }
    if (type === 'end') {
      return { eventType: 'assistant-stream', duplicate: false, duplicateCount: 0, ops };
    }
    stats.malformedCount += 1;
    return { eventType: 'assistant-stream', duplicate: false, duplicateCount: 0, ops };
  }

  function reset() {
    core.appliedSeqs.clear();
    core.appliedChunks.clear();
    core.appliedMessages.clear();
    core.sealedGroups.clear();
    core.groups.clear();
    core.toolParts.clear();
    core.attempts.clear();
    core.records.length = 0;
    core.cursor = -1;
    core.sessionId = address?.kind === 'session'
      ? address.sessionId
      : address?.kind === 'subagent'
        ? address.childSessionId
        : '';
    core.agentPreset = '';
    Object.assign(stats, newStats());
  }

  return {
    ingest,
    stats: () => ({ ...stats }),
    reset,
    cursor: () => core.cursor,
    sessionId: () => core.sessionId,
    address: () => core.address,
    appliedRecords: () => [...core.records],
  };
}

export { IGNORED_EVENTS };
