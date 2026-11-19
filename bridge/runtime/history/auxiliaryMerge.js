import { requireValue } from '../../../shared/runtime/capabilities.js';

/**
 * Task 36 — auxiliary-history canonical merge with terminal guards (bridge side, pure).
 *
 * The runtime merges a bounded history PAGE into the native canonical projection. A tool part that
 * already reached a terminal state (completed/error), and a text/reasoning/continuation part that
 * already reached its terminal (has `time.end`) or is the longer transcript, must NEVER be regressed
 * by a later, less-complete record. Every returned read model is frozen; every rejection carries an
 * explicit code + field via ProtocolError, never a bare throw.
 *
 * Browser-safe: no node builtins, so the app-side cache can bundle this module directly.
 */

export const AUXILIARY_TERMINAL_TOOL_STATUSES = Object.freeze(['completed', 'error']);
const TEXT_KINDS = Object.freeze(['text', 'reasoning', 'continuation']);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isTerminalToolPart(part) {
  return isRecord(part) && part.type === 'tool' && isRecord(part.state)
    && AUXILIARY_TERMINAL_TOOL_STATUSES.includes(String(part.state.status));
}

export function isTerminalTextPart(part) {
  return isRecord(part) && TEXT_KINDS.includes(part.type) && isRecord(part.time) && part.time.end !== undefined;
}

/** Validate one canonical entry; a corrupt record is rejected with an explicit code, not silently dropped. */
export function assertAuxiliaryEntry(entry) {
  requireValue(isRecord(entry) && isRecord(entry.info) && typeof entry.info.id === 'string' && entry.info.id.length > 0
    && Array.isArray(entry.parts) && entry.parts.every(part => isRecord(part) && typeof part.id === 'string' && part.id.length > 0), 'history.record');
  return entry;
}

function freezePart(part) {
  return Object.freeze({ ...part });
}

/** Merge one part; terminal tool/text/continuation state wins over a later non-terminal record. */
export function mergeAuxiliaryPart(existing, incoming) {
  if (existing === undefined) return freezePart(incoming);
  if (existing.id !== incoming.id) return freezePart(incoming);
  if (existing.type === 'tool' && incoming.type === 'tool'
    && isTerminalToolPart(existing) && !isTerminalToolPart(incoming)) return freezePart(existing);
  if (TEXT_KINDS.includes(existing.type) && TEXT_KINDS.includes(incoming.type)) {
    if (isTerminalTextPart(existing) && !isTerminalTextPart(incoming)) return freezePart(existing);
    if (typeof existing.text === 'string' && typeof incoming.text === 'string' && existing.text.length > incoming.text.length) return freezePart(existing);
  }
  return freezePart(incoming);
}

function mergeInfo(existing, incoming) {
  // A completed assistant message keeps its completed info over a later, not-yet-completed one.
  if (isRecord(existing.time) && existing.time.completed !== undefined
    && !(isRecord(incoming.time) && incoming.time.completed !== undefined)) return Object.freeze({ ...existing });
  return Object.freeze({ ...incoming });
}

function mergeEntry(existing, incoming) {
  const parts = new Map(existing.parts.map(part => [part.id, part]));
  for (const part of incoming.parts) parts.set(part.id, mergeAuxiliaryPart(parts.get(part.id), part));
  return { info: mergeInfo(existing.info, incoming.info), parts: [...parts.values()] };
}

/**
 * Merge `incoming` (a history page) into `canonical` (the native projection). `canonical` is the
 * base; `incoming` fills gaps and newer non-terminal data but never regresses a terminal. Returns a
 * frozen, insertion-ordered canonical array. Every entry is validated first.
 */
export function mergeAuxiliaryCanonical(canonical, incoming) {
  const byId = new Map();
  const order = [];
  const admit = (entry) => {
    assertAuxiliaryEntry(entry);
    const existing = byId.get(entry.info.id);
    if (existing === undefined) { byId.set(entry.info.id, entry); order.push(entry.info.id); return; }
    byId.set(entry.info.id, mergeEntry(existing, entry));
  };
  for (const entry of canonical ?? []) admit(entry);
  for (const entry of incoming ?? []) admit(entry);
  return Object.freeze(order.map(id => {
    const entry = byId.get(id);
    return Object.freeze({ info: entry.info, parts: Object.freeze(entry.parts.map(freezePart)) });
  }));
}
