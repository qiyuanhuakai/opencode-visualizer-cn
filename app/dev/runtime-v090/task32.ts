// Task 32 registered QA browser entry — the cross-realm half of the causal Turn timeline contract.
//
// The product under test is TWO implementations of one contract: the bridge service
// (bridge/runtime/threads/turnService.js + timelineProjection.js, driven in the Node worker)
// and its app-side twin (app/runtime/timeline.ts). The Thread UI (task 35) consumes the app
// twin, while the bridge produces the canonical projection — if the two ever diverge, the UI
// would render a timeline the bridge never produced. So this entry drives the REAL
// createTurnTimeline() in a real headless Chromium over the SAME script the worker drives
// through createTurnService(), and the registered case asserts the two read models are
// IDENTICAL: every entry (order, seq, entryId, kind, source, at, payload, late, dedupKey),
// every turn view, the history grouping, the gap list, the paged walk and the state counters.
//
// Only pure ESM runs here (app/runtime/timeline.ts → shared/runtime/capabilities.js →
// shared/runtime/identity.js); none of them touch a node:* builtin and none is a bare or
// aliased specifier, so NO browser shim is needed (task-30 needed one only because the real
// Icon component fetches from the Iconify API at runtime). This entry makes no UI claim and
// authors no PASS verdict.
import {
  DEFAULT_TIMELINE_PAGE_LIMIT,
  MAX_TIMELINE_ENTRY_CHARS,
  MAX_TIMELINE_PAGE_LIMIT,
  TIMELINE_ENTRY_KINDS,
  TIMELINE_TERMINAL_REASONS,
  TURN_COMMAND_PHASES,
  TURN_STATE_FLAGS,
  createTurnTimeline,
} from '../../runtime/timeline';
import type { OpenTurnInput, TimelineSource, TurnTimeline, TurnView } from '../../runtime/timeline';

type AnyRecord = Record<string, any>;

type CommandInput = Parameters<TurnTimeline['command']>[0];
type EventInput = Parameters<TurnTimeline['event']>[0];
type EndInput = Parameters<TurnTimeline['end']>[0];
type PageInput = Parameters<TurnTimeline['page']>[0];
type Op = readonly [string, unknown];
type Rejection = { code: string | null; field: string | null };

const BOUNDARY_TURN = 'c0000000-0000-4000-8000-00000000000c';

const nativeSource = (harness: string, nativeEventId: string): TimelineSource => ({ kind: 'native', harness, nativeEventId });

const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => { errors.push(`unhandledrejection: ${String((event.reason && (event.reason as AnyRecord).message) || event.reason)}`); });

const domHost = document.createElement('pre');
domHost.id = 'qa32-out';
domHost.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace;padding:8px;';
document.body.append(domHost);

/** Captures a typed TurnError's code/field without swallowing anything else. */
function capture(run: () => unknown): Rejection {
  try { run(); return { code: null, field: null }; }
  catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && 'field' in error) {
      const record = error as AnyRecord;
      if (typeof record.code === 'string' && typeof record.field === 'string') return { code: record.code, field: record.field };
    }
    return { code: 'not-a-TurnError', field: String(error) };
  }
}

/** NaN cannot cross page.evaluate's JSON boundary, so the script carries the sentinel. */
function revive(input: unknown): unknown {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as AnyRecord;
    if (record.at === '__NaN__') return { ...record, at: Number.NaN };
  }
  return input;
}

function entryShape(entry: AnyRecord): AnyRecord {
  return {
    entryId: entry.entryId,
    order: entry.order,
    seq: entry.seq,
    turnId: entry.turnId,
    kind: entry.kind,
    source: { ...entry.source },
    at: entry.at,
    payload: entry.payload,
    late: entry.late,
    dedupKey: entry.dedupKey,
  };
}

function turnShape(view: TurnView): AnyRecord {
  return {
    turnId: view.turnId,
    causedBy: view.causedBy,
    parentTurn: view.parentTurn,
    attempt: view.attempt,
    sourceNativeId: view.sourceNativeId,
    accepted: view.accepted,
    acceptedAt: view.acceptedAt,
    acceptedBy: view.acceptedBy,
    sent: view.sent,
    sentAt: view.sentAt,
    sentBy: view.sentBy,
    observed: view.observed,
    observedAt: view.observedAt,
    observedBy: view.observedBy,
    terminal: view.terminal,
    terminalAt: view.terminalAt,
    terminalReason: view.terminalReason,
    terminalBy: view.terminalBy,
    entryCount: view.entryCount,
    lastOrder: view.lastOrder,
    seqMax: view.seqMax,
    createdAtIsPositiveInteger: Number.isInteger(view.createdAt) && view.createdAt > 0,
  };
}

/** The exact read model the worker builds from the bridge service for the same script. */
function snapshotOf(timeline: TurnTimeline, focus: string): AnyRecord {
  const page = timeline.page({});
  const turns = timeline.turns();
  const history = timeline.history(focus);
  const gaps = timeline.gaps(focus);
  return {
    entries: page.entries.map(entryShape),
    turns: turns.map(turnShape),
    state: { ...timeline.state },
    history: {
      turnId: history.turnId,
      entryCount: history.entryCount,
      sources: history.sources.map((group) => ({ source: { ...group.source }, count: group.count, entries: group.entries.map(entryShape) })),
    },
    gaps: [...gaps],
    page: {
      total: page.total,
      nextCursor: page.nextCursor,
      orders: page.entries.map((entry) => entry.order),
      entryIds: page.entries.map((entry) => entry.entryId),
    },
    frozen: {
      page: Object.isFrozen(page),
      pageEntries: Object.isFrozen(page.entries),
      entries: page.entries.map((entry) => Object.isFrozen(entry)),
      entrySources: page.entries.map((entry) => Object.isFrozen(entry.source)),
      entryPayloads: page.entries.map((entry) => Object.isFrozen(entry.payload)),
      turns: turns.map((view) => Object.isFrozen(view)),
      history: Object.isFrozen(history),
      historySources: Object.isFrozen(history.sources),
      historyGroups: history.sources.map((group) => Object.isFrozen(group)),
      historyGroupEntries: history.sources.map((group) => Object.isFrozen(group.entries)),
      gaps: Object.isFrozen(gaps),
    },
  };
}

/** Drives the registered script through the REAL app-side timeline in this browser realm. */
function drive(script: readonly Op[], focus: string): AnyRecord {
  const timeline = createTurnTimeline();
  const outcomes: Rejection[] = [];
  for (const [op, rawInput] of script) {
    const input = revive(rawInput);
    outcomes.push(capture(() => {
      switch (op) {
        case 'open': timeline.open(input as OpenTurnInput); return;
        case 'command': timeline.command(input as CommandInput); return;
        case 'event': timeline.event(input as EventInput); return;
        case 'end': timeline.end(input as EndInput); return;
        case 'turn': return timeline.turn(input as string);
        case 'page': return timeline.page(input as PageInput);
        case 'history': return timeline.history(input as string);
        case 'gaps': return timeline.gaps(input as string);
        default: throw new Error(`unknown op ${op}`);
      }
    }));
  }
  return { outcomes, snapshot: snapshotOf(timeline, focus) };
}

/**
 * Observed-state probe: does a REJECTED event still mark the turn observed?
 * The two twins differ here — app/runtime/timeline.ts parses kind/seq/time BEFORE observing
 * (event() lines 641-648), so a rejected kind/seq/time leaves observed false, while a rejected
 * payload observes first and then throws inside recordEntry. The registered case asserts BOTH
 * observed values explicitly instead of forcing one side.
 */
function observedAfterRejection(probe: string): AnyRecord {
  const timeline = createTurnTimeline();
  const turn = timeline.open({ turnId: BOUNDARY_TURN, causedBy: 'cmd-1' });
  capture(() => {
    if (probe === 'kind') timeline.event({ turnId: turn.turnId, source: nativeSource('opencode', 'ev-1'), kind: 'permission' as 'message', at: 1, payload: {} });
    else if (probe === 'seq') timeline.event({ turnId: turn.turnId, source: nativeSource('opencode', 'ev-1'), kind: 'message', at: 1, seq: -1, payload: {} });
    else if (probe === 'payload') timeline.event({ turnId: turn.turnId, source: nativeSource('opencode', 'ev-1'), kind: 'message', at: 1, payload: [1, 2] as unknown as Record<string, unknown> });
    else timeline.event({ turnId: turn.turnId, source: nativeSource('opencode', 'ev-1'), kind: 'message', at: Number.NaN, payload: {} });
  });
  const view = timeline.turn(turn.turnId);
  return { observed: view.observed, observedAt: view.observedAt, observedBy: view.observedBy };
}

/** The oversized-payload ceiling, observed in this realm with real byte sizes. */
function boundary(): AnyRecord {
  const timeline = createTurnTimeline();
  const turn = timeline.open({ turnId: BOUNDARY_TURN, causedBy: 'cmd-1' });
  const max = MAX_TIMELINE_ENTRY_CHARS;
  const singleOverhead = JSON.stringify({ text: '' }).length;
  const multiOverhead = JSON.stringify({ a: '', b: 1 }).length;
  const exactSingleText = 'x'.repeat(max - singleOverhead);
  const overSingleText = 'x'.repeat(max - singleOverhead + 1);
  const exactMultiText = 'x'.repeat(max - multiOverhead);
  const overMultiText = 'x'.repeat(max - multiOverhead + 1);
  const exactSingle = capture(() => timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-exact-single'), kind: 'message', at: 1, payload: { text: exactSingleText } }));
  const exactSingleSerialized = JSON.stringify({ text: exactSingleText }).length;
  const overSingle = capture(() => timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-over-single'), kind: 'message', at: 2, payload: { text: overSingleText } }));
  const overSingleSerialized = JSON.stringify({ text: overSingleText }).length;
  const exactMulti = capture(() => timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-exact-multi'), kind: 'message', at: 3, payload: { a: exactMultiText, b: 1 } }));
  const exactMultiSerialized = JSON.stringify({ a: exactMultiText, b: 1 }).length;
  const overMulti = capture(() => timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-over-multi'), kind: 'message', at: 4, payload: { a: overMultiText, b: 1 } }));
  const overMultiSerialized = JSON.stringify({ a: overMultiText, b: 1 }).length;
  const retained = timeline.page({ limit: 10 });
  domHost.textContent = JSON.stringify({ max, singleOverhead, multiOverhead, retainedTotal: retained.total }, null, 2);
  return {
    maxChars: max,
    singleOverhead,
    multiOverhead,
    exactSingle,
    exactSingleSerialized,
    exactSingleTextLength: exactSingleText.length,
    overSingle,
    overSingleSerialized,
    overSingleTextLength: overSingleText.length,
    exactMulti,
    exactMultiSerialized,
    exactMultiTextLength: exactMultiText.length,
    overMulti,
    overMultiSerialized,
    overMultiTextLength: overMultiText.length,
    retainedTotal: retained.total,
    retainedEntryIds: retained.entries.map((entry) => entry.entryId),
    retainedSerializedLengths: retained.entries.map((entry) => JSON.stringify(entry.payload).length),
    retainedPayloadKeys: retained.entries.map((entry) => Object.keys(entry.payload)),
  };
}

/** The fixed tables and ceilings, observed in this realm. */
function tables(): AnyRecord {
  const all = [TURN_STATE_FLAGS, TIMELINE_ENTRY_KINDS, TIMELINE_TERMINAL_REASONS, TURN_COMMAND_PHASES];
  domHost.textContent = JSON.stringify({ stateFlags: [...TURN_STATE_FLAGS], kinds: [...TIMELINE_ENTRY_KINDS] }, null, 2);
  return {
    stateFlags: [...TURN_STATE_FLAGS],
    kinds: [...TIMELINE_ENTRY_KINDS],
    reasons: [...TIMELINE_TERMINAL_REASONS],
    phases: [...TURN_COMMAND_PHASES],
    maxEntryChars: MAX_TIMELINE_ENTRY_CHARS,
    defaultLimit: DEFAULT_TIMELINE_PAGE_LIMIT,
    maxLimit: MAX_TIMELINE_PAGE_LIMIT,
    allTablesFrozen: all.every((table) => Object.isFrozen(table)),
  };
}

const api = {
  ready: true,
  errors: () => errors,
  drive,
  observedAfterRejection,
  boundary,
  tables,
  domText: () => domHost.textContent ?? '',
};

(window as unknown as AnyRecord).task32 = api;
