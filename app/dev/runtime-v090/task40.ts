// Task 40 registered QA browser entry — the cross-realm half of the writer-lease / change-artifact
// contract.
//
// The product under test is bridge-side: bridge/runtime/collaboration/writerLeases.js imports
// node:crypto / node:fs / node:path / node:child_process, artifactStore.js imports node:crypto /
// node:fs, and artifactService.js imports node:crypto / node:fs / node:path plus writerLeases.js,
// so the STATEFUL surface — allocate, the lease read models, the native runner, capture, apply,
// release, confirm, remove — cannot run in a browser realm at all and is driven in the Node worker
// only, exactly the split tasks 37 and 38 disclosed for their coordinators and fan-out service.
// What CAN and MUST cross a process boundary is proven here, in a second JS realm:
//
//   * the frozen shared contract every writer-lease and artifact rejection travels through — the
//     frozen ten-entry ERROR_CODES table, the CollaborationError shape (name, code, field, reason,
//     message, frozen detail, ProtocolError and TypeError lineage) and the explicit-`at` contract —
//     recomputed from the same pure shared/runtime modules the worker imports;
//   * the id parsers the lease surface validates every caller through — parseLeaseId and
//     parseTaskId accept a well-formed UUID and normalise its case, and refuse a malformed one
//     with invalid_request/lease_id or invalid_request/task_id — so a browser window and the
//     bridge worker provably agree on what a lease identity is before any allocation happens;
//   * the membership check: every rejection code the worker actually observed across the whole
//     case is a member of the frozen canonical table, checked in THIS realm over the list the
//     worker collected.
//
// No browser shim is needed (the closure is shared/runtime/collaboration.js -> capabilities.js +
// identity.js, pure ESM with no node:* builtin and no bare or aliased specifier — a strict subset
// of the closure task 38 booted in a real headless Chromium) and none is authored. This entry
// makes no UI claim — task 42 owns the collaboration UI — and authors no PASS verdict.
import {
  CollaborationError,
  parseAt,
  parseLeaseId,
  parseTaskId,
} from '../../../shared/runtime/collaboration.js';
import {
  ERROR_CODES,
  ProtocolError,
} from '../../../shared/runtime/capabilities.js';

type AnyRecord = Record<string, any>;

/* ---------------------------------------------------------------- fixtures and capture */

const T0 = 1700000000000;
// A well-formed lease / task identity in mixed case: the parsers normalise, they do not refuse.
const MIXED_CASE_UUID = 'AABBCCDD-AABB-4ABB-8ABB-AABBCCDDAABB';
const LOWER_CASE_UUID = 'aabbccdd-aabb-4abb-8abb-aabbccddaabb';

const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => { errors.push(`unhandledrejection: ${String((event.reason && (event.reason as AnyRecord).message) || event.reason)}`); });

const domHost = document.createElement('pre');
domHost.id = 'qa40-out';
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

/** The frozen shared contract every writer-lease / artifact rejection travels through. */
function tables(): AnyRecord {
  const payload = {
    errorCodes: [...ERROR_CODES],
    errorCodeCount: ERROR_CODES.length,
    errorCodesFrozen: Object.isFrozen(ERROR_CODES),
    collaborationErrorShape: (() => {
      const error = new CollaborationError('conflict', 'writer_lease_cwd', { x: 1 });
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
    // The codes the writer-lease and artifact surfaces can actually emit, checked in THIS realm.
    writerArtifactCodesInTable: ['invalid_request', 'unsupported', 'unauthorized', 'conflict', 'cancelled', 'source_unavailable']
      .every((code) => ERROR_CODES.includes(code as never)),
    atExplicit: parseAt(T0),
    atZero: capture(() => parseAt(0)),
    atNegative: capture(() => parseAt(-1)),
    atFractional: capture(() => parseAt(1.5)),
    atNonNumber: capture(() => parseAt('1700000000000' as unknown as number)),
  };
  domHost.textContent = JSON.stringify(payload, null, 2);
  return payload;
}

/**
 * The lease / task id parsers this realm applies. The worker asserts these equal the values the
 * REAL writer-lease service enforces (allocate with a malformed task id is refused
 * invalid_request/task_id; lease() with a malformed lease id is refused invalid_request/lease_id),
 * so a browser window and the bridge worker provably agree on what a lease identity is.
 */
function ids(): AnyRecord {
  const payload = {
    leaseIdAccepted: parseLeaseId(MIXED_CASE_UUID),
    leaseIdNormalised: parseLeaseId(MIXED_CASE_UUID) === LOWER_CASE_UUID,
    leaseIdMalformed: capture(() => parseLeaseId('nope')),
    taskIdAccepted: parseTaskId(MIXED_CASE_UUID),
    taskIdNormalised: parseTaskId(MIXED_CASE_UUID) === LOWER_CASE_UUID,
    taskIdMalformed: capture(() => parseTaskId('not-a-uuid')),
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
  ids,
  codeMembership,
  domText: () => domHost.textContent ?? '',
};

(window as unknown as AnyRecord).task40 = api;
