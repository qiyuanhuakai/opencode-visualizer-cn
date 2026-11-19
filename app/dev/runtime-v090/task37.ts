// Task 37 registered QA browser entry — the cross-realm half of the frozen collaboration contract.
//
// The product under test is bridge-side and Node-only: bridge/runtime/collaboration/coordinator.js,
// taskGraph.js and attemptService.js each import from node:crypto on line 1, so the coordinator
// itself cannot run in a browser realm at all. The registered case therefore drives the REAL
// coordinator (composed from the real task graph, attempt service and acceptance service) in the
// Node worker, and this entry proves the ONE part of the contract that must hold across a process
// boundary: the frozen shared contract — the five coordination budgets, the task/attempt/review/
// acceptance state tables, the budget-reason table, the frozen ceilings, the canonical native
// session keys the Session-mutation budget is counted under, the id parsers every rejection
// travels through, and the frozen protocol error-code table every rejection code must belong to.
//
// The split is stated rather than papered over, exactly as task 34 disclosed it:
//   * the acceptance-sink boundary (createAcceptanceSink from
//     bridge/runtime/collaboration/acceptanceService.js) and the attempt sink table
//     (createNativeSink / createDeliverySink / createHostSink from attemptService.js) are proven in
//     the Node worker ONLY, because neither module ships a sibling declaration file, so a static
//     import would be TS7016 under the repo's strict vue-tsc gate (the same reason the product's own
//     collaborationCoordinator.test.ts uses a createRequire boundary for those modules) — and
//     attemptService.js imports node:crypto anyway, so it cannot enter this realm at all;
//   * no browser shim is needed: the closure here is shared/runtime/collaboration.js ->
//     capabilities.js + identity.js, pure ESM with no node:* builtin and no bare or aliased
//     specifier, so Vite resolves every import natively. task-30 needed a shim only because the real
//     Icon component fetches from the Iconify API at runtime.
//
// This entry makes no UI claim (task 42 owns the collaboration UI) and authors no PASS verdict.
import {
  ACCEPTANCE_STATES,
  ATTEMPT_STATES,
  ATTEMPT_TERMINAL_REASONS,
  BUDGET_REASONS,
  COLLABORATION_BUDGETS,
  COLLABORATION_SCHEMA_VERSION,
  CollaborationError,
  MAX_CRITERIA_COUNT,
  MAX_CRITERION_CHARS,
  MAX_CRITERION_ID_CHARS,
  MAX_DELIVERABLES,
  MAX_DELIVERABLE_PATHS,
  MAX_MAILBOX_TEXT_CHARS,
  MAX_NAMES,
  MAX_PATH_CHARS,
  MAX_TASK_TITLE_CHARS,
  REVIEW_STATES,
  TASK_STATES,
  collaborationBudgetLimits,
  parseAt,
  parseCriteria,
  parseCriteriaVerdicts,
  parseCriterion,
  parseDeliverable,
  parseLeaseInput,
  parseOwner,
  parseSessionMutationKey,
  parseTaskId,
  parseTaskTitle,
  parseTeamName,
} from '../../../shared/runtime/collaboration.js';
import {
  ERROR_CODES,
  ProtocolError,
} from '../../../shared/runtime/capabilities.js';
import {
  decodeSessionKey,
  encodeSessionKey,
  parseEnvironmentId,
  parseHarnessInstanceId,
  parseSessionRef,
} from '../../../shared/runtime/identity.js';
import type { SessionRef } from '../../../shared/runtime/identity.js';

type AnyRecord = Record<string, any>;

const ENV_A = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
// The five harness kinds of this plan: opencode, codex, kimi-web, dsh, acp.
const H_CODEX = parseHarnessInstanceId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const H_ACP = parseHarnessInstanceId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const H_KIMI = parseHarnessInstanceId('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
const H_DSH = parseHarnessInstanceId('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
const H_OPENCODE = parseHarnessInstanceId('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');

// Built through the real parseSessionRef so each ref IS the frozen SessionRef a task owner carries.
const session = (harness: string, nativeSessionId: string): SessionRef =>
  parseSessionRef({ environmentId: ENV_A, harnessInstanceId: harness, nativeSessionId });
const SESSION_CODEX = session(H_CODEX, 'native:codex-1');
const SESSION_ACP = session(H_ACP, 'native:acp-1');
const SESSION_KIMI = session(H_KIMI, 'native:kimi-1');
const SESSION_DSH = session(H_DSH, 'native:dsh-1');
const SESSION_OPENCODE = session(H_OPENCODE, 'native:opencode-1');

const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => { errors.push(`unhandledrejection: ${String((event.reason && (event.reason as AnyRecord).message) || event.reason)}`); });

const domHost = document.createElement('pre');
domHost.id = 'qa37-out';
domHost.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace;padding:8px;';
document.body.append(domHost);

/**
 * Captures a typed CollaborationError's code/field without swallowing anything else. The SAME
 * envelope is emitted on EVERY path, success included (the task-32/33 lesson): { code: null,
 * field: null } on success, so the worker's capture and this one are comparable key-for-key.
 */
function capture(run: () => unknown): { code: string | null; field: string | null } {
  try { run(); return { code: null, field: null }; }
  catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && 'field' in error) {
      const record = error as AnyRecord;
      if (typeof record.code === 'string' && typeof record.field === 'string') return { code: record.code, field: record.field };
    }
    return { code: 'not-a-CollaborationError', field: String(error) };
  }
}

/** The frozen contract: the five budgets, every state table, the ceilings and the error vocabulary. */
function tables(): AnyRecord {
  const payload = {
    schemaVersion: COLLABORATION_SCHEMA_VERSION,
    budgets: { ...COLLABORATION_BUDGETS },
    budgetsFrozen: Object.isFrozen(COLLABORATION_BUDGETS),
    limitsFromFunction: { ...collaborationBudgetLimits() },
    taskStates: [...TASK_STATES],
    attemptStates: [...ATTEMPT_STATES],
    terminalReasons: [...ATTEMPT_TERMINAL_REASONS],
    reviewStates: [...REVIEW_STATES],
    acceptanceStates: [...ACCEPTANCE_STATES],
    budgetReasons: [...BUDGET_REASONS],
    ceilings: {
      maxTaskTitleChars: MAX_TASK_TITLE_CHARS,
      maxCriteriaCount: MAX_CRITERIA_COUNT,
      maxCriterionIdChars: MAX_CRITERION_ID_CHARS,
      maxCriterionChars: MAX_CRITERION_CHARS,
      maxDeliverables: MAX_DELIVERABLES,
      maxDeliverablePaths: MAX_DELIVERABLE_PATHS,
      maxPathChars: MAX_PATH_CHARS,
      maxMailboxTextChars: MAX_MAILBOX_TEXT_CHARS,
      maxNames: { ...MAX_NAMES },
    },
    errorCodes: [...ERROR_CODES],
    errorCodeCount: ERROR_CODES.length,
    errorCodesFrozen: Object.isFrozen(ERROR_CODES),
    collaborationErrorShape: (() => {
      const error = new CollaborationError('conflict', 'task_cycle', { taskId: 'x' });
      return {
        name: error.name,
        code: error.code,
        field: error.field,
        reason: error.reason,
        message: error.message,
        detail: error.detail === null ? null : { ...error.detail },
        isProtocolError: error instanceof ProtocolError,
        isTypeError: error instanceof TypeError,
      };
    })(),
    // The five coordination codes the coordinator can actually emit, checked in THIS realm.
    coordinationCodesInTable: ['invalid_request', 'conflict', 'cancelled', 'source_unavailable', 'reconcile_required']
      .every((code) => ERROR_CODES.includes(code as never)),
  };
  domHost.textContent = JSON.stringify(payload, null, 2);
  return payload;
}

/**
 * The canonical native-session keys this realm computes for the five harness kinds. The worker
 * asserts these equal the keys it computes from the REAL task-owner records, so a browser window
 * and the bridge worker provably agree on the identity the Session-mutation budget counts under.
 */
function sessionKeys(): AnyRecord {
  const keys = {
    codex: encodeSessionKey(SESSION_CODEX),
    acp: encodeSessionKey(SESSION_ACP),
    kimi: encodeSessionKey(SESSION_KIMI),
    dsh: encodeSessionKey(SESSION_DSH),
    opencode: encodeSessionKey(SESSION_OPENCODE),
    codexDuplicate: encodeSessionKey(session(H_CODEX, 'native:codex-1')),
    mutationKeyCodex: parseSessionMutationKey(SESSION_CODEX),
    mutationKeyEqualsEncode: parseSessionMutationKey(SESSION_CODEX) === encodeSessionKey(SESSION_CODEX),
    mutationKeyDiffersAcrossHarnesses: parseSessionMutationKey(SESSION_CODEX) !== parseSessionMutationKey(SESSION_ACP),
    mutationKeyMalformed: capture(() => parseSessionMutationKey({ environmentId: ENV_A })),
    decoded: (() => {
      const decoded = decodeSessionKey(encodeSessionKey(SESSION_KIMI));
      return { environmentId: decoded.environmentId, harnessInstanceId: decoded.harnessInstanceId, nativeSessionId: decoded.nativeSessionId };
    })(),
  };
  domHost.textContent = JSON.stringify(keys, null, 2);
  return keys;
}

/**
 * The id and shape parsers every rejection travels through, at their exact boundaries. These are
 * pure functions of the frozen contract, so their accept/refuse boundary is engine-independent.
 */
function parsers(): AnyRecord {
  const owner = { participantId: '15151515-1515-4515-8515-151515151511', session: SESSION_CODEX };
  const criteria = [{ id: 'build', text: 'the production build passes' }, { id: 'tests', text: 'the focused regression passes', required: true }];
  const payload = {
    taskId: parseTaskId('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'),
    taskIdLowercased: parseTaskId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    badTaskId: capture(() => parseTaskId('nope')),
    teamName512: parseTeamName('t'.repeat(512)).length,
    teamNameEmpty: capture(() => parseTeamName('')),
    teamName513: capture(() => parseTeamName('t'.repeat(513))),
    taskTitle512: parseTaskTitle('t'.repeat(512)).length,
    taskTitle513: capture(() => parseTaskTitle('t'.repeat(513))),
    criteriaParsed: parseCriteria(criteria).map((entry) => ({ id: entry.id, required: entry.required })),
    criteriaEmpty: capture(() => parseCriteria([])),
    criteriaDuplicateIds: capture(() => parseCriteria([{ id: 'build', text: 'a' }, { id: 'build', text: 'b' }])),
    criterionDefaultsRequired: parseCriterion({ id: 'build', text: 'a' }).required,
    criterionRejectsExtraKey: capture(() => parseCriterion({ id: 'build', text: 'a', extra: 1 } as never)),
    ownerParsed: (() => {
      const parsed = parseOwner(owner);
      return { participantId: parsed.participantId, nativeSessionId: parsed.session.nativeSessionId, frozen: Object.isFrozen(parsed) };
    })(),
    ownerMissingSession: capture(() => parseOwner({ participantId: '15151515-1515-4515-8515-151515151511' })),
    leaseInput: (() => {
      const parsed = parseLeaseInput({ ownerId: '12121212-1212-4212-8212-121212121211', expiresAt: 1700000600000 });
      return { ownerId: parsed.ownerId, expiresAt: parsed.expiresAt };
    })(),
    leaseBadExpiry: capture(() => parseLeaseInput({ ownerId: '12121212-1212-4212-8212-121212121211', expiresAt: -1 })),
    deliverable: (() => {
      const parsed = parseDeliverable({ deliverableId: 'deliverable-1', artifactHash: 'f'.repeat(64), bytes: 4096, paths: ['bridge/runtime/collaboration/coordinator.js'] });
      return { deliverableId: parsed.deliverableId, artifactHash: parsed.artifactHash, bytes: parsed.bytes, paths: [...parsed.paths] };
    })(),
    deliverableBadHash: capture(() => parseDeliverable({ deliverableId: 'd', artifactHash: 'nope', bytes: 1, paths: ['a'] })),
    deliverableEmptyPaths: capture(() => parseDeliverable({ deliverableId: 'd', artifactHash: 'f'.repeat(64), bytes: 1, paths: [] })),
    verdicts: parseCriteriaVerdicts([{ id: 'build', met: true }, { id: 'tests', met: false }], parseCriteria(criteria)).map((entry) => ({ id: entry.id, met: entry.met })),
    verdictsWrongCount: capture(() => parseCriteriaVerdicts([{ id: 'build', met: true }], parseCriteria(criteria))),
    verdictsUnknownId: capture(() => parseCriteriaVerdicts([{ id: 'build', met: true }, { id: 'nope', met: true }], parseCriteria(criteria))),
    atExplicit: parseAt(1700000000000),
    atZero: capture(() => parseAt(0)),
    atFractional: capture(() => parseAt(1.5)),
  };
  domHost.textContent = JSON.stringify(payload, null, 2);
  return payload;
}

/**
 * Every rejection code the worker actually observed across the whole case is a member of the
 * frozen canonical table — checked in this realm too, over the list the worker collected.
 */
function codeMembership(codes: readonly string[]): AnyRecord {
  const missing = codes.filter((code) => !ERROR_CODES.includes(code as never));
  domHost.textContent = JSON.stringify({ observedCount: codes.length, missing }, null, 2);
  return {
    observedCount: codes.length,
    missing,
    allObservedCodesInTable: missing.length === 0,
    distinctObserved: new Set(codes).size,
  };
}

const api = {
  ready: true,
  errors: () => errors,
  tables,
  sessionKeys,
  parsers,
  codeMembership,
  domText: () => domHost.textContent ?? '',
};

(window as unknown as AnyRecord).task37 = api;
