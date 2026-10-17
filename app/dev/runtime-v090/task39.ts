// Task 39 registered QA browser entry — the cross-realm half of the Lead/Worker delegation, Team
// tool and member-message contract.
//
// The product under test is bridge-side: bridge/runtime/collaboration/delegationService.js,
// mailbox.js, toolServer.js and toolCapabilities.js each import node:crypto on line 1
// (randomUUID), so the STATEFUL services (teams, members, scopes, delegate, evidence, messages,
// control, sweep, reconcile, the temporary scoped tools) cannot run in a browser realm at all and
// are driven in the Node worker only — exactly the split tasks 37 and 38 disclosed for their
// coordinator and fan-out service. What CAN and MUST cross a process boundary is proven here, in a
// second JS realm, from the same pure shared/runtime modules the worker imports:
//
//   * the frozen shared contract every delegation and mailbox rejection travels through — the five
//     coordination budgets (concurrency 4, Session mutation 1, depth 4, children 32, mailbox 1000)
//     as ONE frozen object, the five budget reasons, every frozen ceiling, the frozen ten-entry
//     ERROR_CODES table, the CollaborationError shape and the explicit-`at` contract;
//   * the five harness kinds of this plan and the canonical native-session key each of them
//     produces, so a browser window and the bridge worker provably agree on the identity a member
//     carries — the worker asserts the product's OWN sessionKey values (written by the real
//     addMember into a real member read model) equal the keys this realm computes;
//   * the id and shape parsers every rejection travels through — task id, team id and message id
//     lowercasing with their non-UUID refusals, the team-name and task-title ceilings, the criteria
//     parser and the hash-identified deliverable shape.
//
// No browser shim is needed (the whole closure is pure ESM: collaboration.js -> capabilities.js +
// identity.js, harnessContract.js -> identity.js + capabilities.js + nativeExtensions.js, and
// nativeExtensions.js imports nothing at all) and none is authored. This entry makes no UI claim —
// task 42 owns the collaboration UI — and authors no PASS verdict. The "UI-only driver dispatches
// through the UI" criterion is satisfied in the worker by driving the product's OWN tool server and
// capability model (callFromUi through the same scope checks), never by claiming a rendered
// component.
import {
  BUDGET_REASONS,
  COLLABORATION_BUDGETS,
  COLLABORATION_SCHEMA_VERSION,
  CollaborationError,
  MAX_CRITERION_CHARS,
  MAX_CRITERIA_COUNT,
  MAX_CRITERION_ID_CHARS,
  MAX_DELIVERABLE_PATHS,
  MAX_DELIVERABLES,
  MAX_MAILBOX_TEXT_CHARS,
  MAX_NAMES,
  MAX_PATH_CHARS,
  MAX_TASK_TITLE_CHARS,
  collaborationBudgetLimits,
  parseAt,
  parseCriterion,
  parseCriteria,
  parseDeliverable,
  parseMessageId,
  parseTaskId,
  parseTaskTitle,
  parseTeamId,
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
import { HARNESS_KINDS } from '../../../shared/runtime/harnessContract.js';

type AnyRecord = Record<string, any>;

/* ---------------------------------------------------------------- fixtures and capture */

// T0, the session identity (the environment, the five harness instance ids and the five native
// session ids) and every parser input are NO LONGER hard-coded in this realm. They are injected
// from the case module as ONE shared object (the twenty-sixth-instance lesson: this browser realm
// once hard-coded the deliverable evidence with ONE path while the case carried TWO, so the
// cross-realm equality could never hold). tables(), sessionKeys() and parsers() build their values
// from the injected `inputs`, identical by construction with the worker realm.

const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => { errors.push(`unhandledrejection: ${String((event.reason && (event.reason as AnyRecord).message) || event.reason)}`); });

const domHost = document.createElement('pre');
domHost.id = 'qa39-out';
domHost.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace;padding:8px;';
document.body.append(domHost);

/**
 * Captures a typed CollaborationError's code/field without swallowing anything else. The SAME
 * envelope is emitted on EVERY path, success included: { code: null, field: null } on success, so
 * the worker's capture and this one are comparable key-for-key.
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

/* ---------------------------------------------------------------- the browser-realm captures */

/** The frozen shared contract every delegation and mailbox rejection travels through. */
function tables(inputs: AnyRecord): AnyRecord {
  const payload = {
    schemaVersion: COLLABORATION_SCHEMA_VERSION,
    budgets: { ...COLLABORATION_BUDGETS },
    budgetsFrozen: Object.isFrozen(COLLABORATION_BUDGETS),
    limitsFromFunction: { ...collaborationBudgetLimits() },
    budgetReasons: [...BUDGET_REASONS],
    budgetReasonsFrozen: Object.isFrozen(BUDGET_REASONS),
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
    harnessKinds: [...HARNESS_KINDS],
    harnessKindsFrozen: Object.isFrozen(HARNESS_KINDS),
    errorCodes: [...ERROR_CODES],
    errorCodeCount: ERROR_CODES.length,
    errorCodesFrozen: Object.isFrozen(ERROR_CODES),
    collaborationErrorShape: (() => {
      const error = new CollaborationError(inputs.contract.errorShape.code, inputs.contract.errorShape.field, inputs.contract.errorShape.detail);
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
    // The seven codes the four product modules can actually emit, checked in THIS realm.
    delegationCodesInTable: inputs.contract.delegationCodes
      .every((code: string) => ERROR_CODES.includes(code as never)),
    atExplicit: parseAt(inputs.at.explicit),
    atZero: capture(() => parseAt(inputs.at.zero)),
    atFractional: capture(() => parseAt(inputs.at.fractional)),
  };
  domHost.textContent = JSON.stringify(payload, null, 2);
  return payload;
}

/**
 * The canonical native-session keys this realm computes for the five harness kinds. The worker
 * asserts these equal the sessionKey values the REAL addMember wrote into a real member read
 * model, so a browser window and the bridge worker provably agree on the identity each member
 * carries. The identity (environment, the five harness instance ids and the five native session
 * ids) is INJECTED from the case — the worker feeds addMember the very same strings — so the two
 * realms agree by construction, not by coincidence.
 */
function sessionKeys(inputs: AnyRecord): AnyRecord {
  const identity = inputs.identity;
  const ENV_A = parseEnvironmentId(identity.environmentId);
  const H_CODEX = parseHarnessInstanceId(identity.harness.codex);
  const H_ACP = parseHarnessInstanceId(identity.harness.acp);
  const H_KIMI = parseHarnessInstanceId(identity.harness.kimi);
  const H_DSH = parseHarnessInstanceId(identity.harness.dsh);
  const H_OPENCODE = parseHarnessInstanceId(identity.harness.opencode);
  const session = (harness: string, nativeSessionId: string): SessionRef =>
    parseSessionRef({ environmentId: ENV_A, harnessInstanceId: harness, nativeSessionId });
  const SESSION_CODEX = session(H_CODEX, identity.native.codex);
  const SESSION_ACP = session(H_ACP, identity.native.acp);
  const SESSION_KIMI = session(H_KIMI, identity.native.kimi);
  const SESSION_DSH = session(H_DSH, identity.native.dsh);
  const SESSION_OPENCODE = session(H_OPENCODE, identity.native.opencode);
  const keys = {
    opencode: encodeSessionKey(SESSION_OPENCODE),
    codex: encodeSessionKey(SESSION_CODEX),
    acp: encodeSessionKey(SESSION_ACP),
    kimi: encodeSessionKey(SESSION_KIMI),
    dsh: encodeSessionKey(SESSION_DSH),
    codexDuplicate: encodeSessionKey(session(H_CODEX, identity.native.codex)),
    decoded: (() => {
      const decoded = decodeSessionKey(encodeSessionKey(SESSION_KIMI));
      return { environmentId: decoded.environmentId, harnessInstanceId: decoded.harnessInstanceId, nativeSessionId: decoded.nativeSessionId };
    })(),
  };
  domHost.textContent = JSON.stringify(keys, null, 2);
  return keys;
}

/**
 * The id and shape parsers every rejection travels through, recomputed in this realm from the same
 * pure shared module the worker imports. Every input is INJECTED from the case as ONE shared
 * object, so the worker and this realm feed the parsers byte-identical inputs — the deliverable
 * evidence's TWO paths included, the exact value this browser realm once dropped.
 */
function parsers(inputs: AnyRecord): AnyRecord {
  const parser = inputs.parser;
  const payload = {
    taskId: parseTaskId(parser.taskId),
    taskIdLowercased: parseTaskId(parser.taskIdLower),
    badTaskId: capture(() => parseTaskId(parser.badTaskId)),
    teamId: parseTeamId(parser.teamId),
    badTeamId: capture(() => parseTeamId(parser.badTaskId)),
    messageId: parseMessageId(parser.messageId),
    badMessageId: capture(() => parseMessageId(parser.badMessageId)),
    teamName512: parseTeamName(parser.teamName512).length,
    teamNameEmpty: capture(() => parseTeamName('')),
    teamName513: capture(() => parseTeamName(parser.teamName513)),
    taskTitle512: parseTaskTitle(parser.taskTitle512).length,
    taskTitle513: capture(() => parseTaskTitle(parser.taskTitle513)),
    criteriaParsed: parseCriteria(parser.criteria).map((entry) => ({ id: entry.id, text: entry.text, required: entry.required })),
    criteriaEmpty: capture(() => parseCriteria([])),
    criteriaDuplicateIds: capture(() => parseCriteria(parser.criteriaDuplicate)),
    criterionDefaultsRequired: parseCriterion(parser.criterionA).required,
    criterionRejectsExtraKey: capture(() => parseCriterion(parser.criterionExtra)),
    deliverable: (() => {
      const parsed = parseDeliverable(parser.evidence);
      return { deliverableId: parsed.deliverableId, artifactHash: parsed.artifactHash, bytes: parsed.bytes, paths: [...parsed.paths] };
    })(),
    deliverableBadHash: capture(() => parseDeliverable(parser.deliverableBadHash)),
    deliverableEmptyPaths: capture(() => parseDeliverable(parser.deliverableEmptyPaths)),
    atExplicit: parseAt(inputs.at.explicit),
    atZero: capture(() => parseAt(inputs.at.zero)),
    atFractional: capture(() => parseAt(inputs.at.fractional)),
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

(window as unknown as AnyRecord).task39 = api;
