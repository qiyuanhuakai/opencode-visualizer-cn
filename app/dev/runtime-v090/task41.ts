// Task 41 registered QA browser entry — the cross-realm half of the post-review integration contract.
//
// The product under test is bridge-side and git-shaped: bridge/runtime/collaboration/
// integrationService.js imports node:crypto / node:fs / node:path / node:child_process plus
// artifactStore.js and writerLeases.js, integrationReview.js imports node:crypto plus
// writerLeases.js, and repositoryLocks.js imports node:crypto / node:path, so the STATEFUL
// surface — create, approve, the review/approval read models, acquire, release, held, grants,
// integrate, the durable results, the temporary integration worktree, the controlled
// fast-forward — cannot run in a browser realm at all and is driven in the Node worker only,
// exactly the split tasks 37, 38, 39 and 40 disclosed for their coordinators, fan-out service,
// delegation surface and writer leases.
// What CAN and MUST cross a process boundary is proven here, in a second JS realm:
//
//   * the frozen shared contract every integration rejection travels through — the frozen
//     ten-entry ERROR_CODES table, the CollaborationError shape (name, code, field, reason,
//     message, frozen detail, ProtocolError and TypeError lineage) and the explicit-`at`
//     contract — recomputed from the same pure shared/runtime modules the worker imports;
//   * the frozen criteria vocabulary the integration service validates every caller through —
//     parseCriteria / parseCriterion at their exact accept/refuse boundaries — so a browser
//     window and the bridge worker provably agree on what a frozen criterion is before any
//     integration is driven;
//   * the membership check: every rejection code the worker actually observed across the whole
//     case is a member of the frozen canonical table, checked in THIS realm over the list the
//     worker collected.
//
// THE ONE SOURCE of every case-owned input is the object the worker passes in as `shared` (the
// twenty-sixth-instance lesson: task 39's two realms each hard-coded the same array with
// different contents, so the cross-realm equality could never hold). The product tables'
// budgets / ceilings / codes are NOT in it — both realms derive those from the shared modules
// they both import, so they are identical by construction already.
//
// No browser shim is needed (the closure is shared/runtime/collaboration.js -> capabilities.js +
// identity.js, pure ESM with no node:* builtin and no bare or aliased specifier — a strict subset
// of the closure task 38 booted in a real headless Chromium) and none is authored. This entry
// makes no UI claim — task 42 owns the collaboration UI — and authors no PASS verdict.
import {
  CollaborationError,
  MAX_CRITERIA_COUNT,
  MAX_CRITERION_CHARS,
  MAX_CRITERION_ID_CHARS,
  parseAt,
  parseCriterion,
  parseCriteria,
} from '../../../shared/runtime/collaboration.js';
import {
  ERROR_CODES,
  ProtocolError,
} from '../../../shared/runtime/capabilities.js';
import type { ErrorCode } from '../../../shared/runtime/capabilities.js';

type AnyRecord = Record<string, any>;

/* ---------------------------------------------------------------- fixtures and capture */

const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => { errors.push(`unhandledrejection: ${String((event.reason && (event.reason as AnyRecord).message) || event.reason)}`); });

const domHost = document.createElement('pre');
domHost.id = 'qa41-out';
domHost.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace;padding:8px;';
document.body.append(domHost);

/**
 * Captures a typed CollaborationError's code/field without swallowing anything else. The SAME
 * envelope is emitted on EVERY path, success included: { code: null, field: null } on success, so
 * the worker's capture and this one are comparable key-for-key (the task-32/33 lesson).
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

/** The frozen shared contract every integration rejection travels through. */
function tables(shared: AnyRecord): AnyRecord {
  const shape = shared.errorShape as { code: ErrorCode; field: string; detail: AnyRecord };
  const payload = {
    errorCodes: [...ERROR_CODES],
    errorCodeCount: ERROR_CODES.length,
    errorCodesFrozen: Object.isFrozen(ERROR_CODES),
    collaborationErrorShape: (() => {
      const error = new CollaborationError(shape.code, shape.field, shape.detail);
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
    // The codes the integration surfaces can actually emit, checked in THIS realm.
    integrationCodesInTable: (shared.integrationCodes as readonly string[])
      .every((code) => ERROR_CODES.includes(code as never)),
    atExplicit: parseAt(shared.at.explicit as number),
    atZero: capture(() => parseAt(shared.at.zero as number)),
    atNegative: capture(() => parseAt(shared.at.negative as number)),
    atFractional: capture(() => parseAt(shared.at.fractional as number)),
    atNonNumber: capture(() => parseAt(shared.at.nonNumber as unknown as number)),
  };
  domHost.textContent = JSON.stringify(payload, null, 2);
  return payload;
}

/**
 * The frozen criteria vocabulary this realm applies, over the SAME raw array the worker feeds the
 * real integration service. The worker asserts these equal the values the REAL service enforces
 * (a criteria list that does not cover every required criterion is refused
 * invalid_request/integration_criteria), so a browser window and the bridge worker provably agree
 * on what a frozen criterion is.
 */
function criteria(raw: readonly AnyRecord[]): AnyRecord {
  const parsed = parseCriteria(raw as never);
  const payload = {
    parsed: parsed.map((entry) => ({ id: entry.id, text: entry.text, required: entry.required })),
    frozen: Object.isFrozen(parsed),
    entryFrozen: Object.isFrozen(parsed[0]),
    defaultsRequired: parseCriterion({ id: 'build', text: 'a' }).required,
    rejectsMissingText: capture(() => parseCriterion({ id: 'build' } as never)),
    rejectsExtraKey: capture(() => parseCriterion({ id: 'build', text: 'a', extra: 1 } as never)),
    rejectsEmpty: capture(() => parseCriteria([])),
    rejectsDuplicateIds: capture(() => parseCriteria([{ id: 'build', text: 'a' }, { id: 'build', text: 'b' }])),
    ceilings: {
      maxCriteriaCount: MAX_CRITERIA_COUNT,
      maxCriterionIdChars: MAX_CRITERION_ID_CHARS,
      maxCriterionChars: MAX_CRITERION_CHARS,
    },
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
  criteria,
  codeMembership,
  domText: () => domHost.textContent ?? '',
};

(window as unknown as AnyRecord).task41 = api;
