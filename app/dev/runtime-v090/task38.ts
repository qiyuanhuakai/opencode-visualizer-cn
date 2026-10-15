// Task 38 registered QA browser entry — the cross-realm half of the partial-failure-recoverable
// fan-out contract.
//
// The product under test is bridge-side: bridge/runtime/collaboration/fanoutService.js imports
// node:crypto on line 1 (randomUUID), so the STATEFUL service (create / dispatch / cancel /
// reconcile / retry) cannot run in a browser realm at all and is driven in the Node worker only —
// exactly the split task 37 disclosed for its coordinator. What CAN and MUST cross a process
// boundary is proven here, in a second JS realm:
//
//   * the frozen shared contract every fan-out rejection travels through — the frozen ten-entry
//     ERROR_CODES table, the CollaborationError shape and the explicit-`at` contract — recomputed
//     from the same pure shared/runtime modules the worker imports;
//   * the canonical native-session key each of the five harness kinds produces, so a browser
//     window and the bridge worker provably agree on the identity each recipient carries — the
//     worker asserts the product's OWN sessionKey values (written by the real createFanout) equal
//     the keys this realm computes;
//   * the REAL recovery planner planFanoutRetry from
//     bridge/runtime/collaboration/fanoutRecovery.js — pure ESM whose only import is
//     shared/runtime/collaboration.js, no node:* builtin and no bare or aliased specifier, so Vite
//     resolves it natively — run over an OBSERVED fan-out read model the worker passes in. The
//     worker runs the same product function over the same bytes and asserts the two realms agree,
//     which is what makes "retry only explicitly-safe unsent, ambiguous 禁重发" engine-independent.
//
// No browser shim is needed (the whole closure is pure ESM) and none is authored. This entry makes
// no UI claim — task 42 owns the collaboration UI — and authors no PASS verdict. The per-recipient
// state "list" this entry prints is the product's OWN read model driven through the product's OWN
// recovery planner, not a rendered component.
import {
  CollaborationError,
  parseAt,
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

/* ---------------------------------------------------------------- read-model contracts */

/** The fan-out read model as the product freezes it (fanoutService.js recipientView / fanoutView). */
interface FanoutSessionRef {
  readonly environmentId: string;
  readonly harnessInstanceId: string;
  readonly nativeSessionId: string;
}
interface FanoutRecipientView {
  readonly recipientId: string;
  readonly participantId: string;
  readonly session: FanoutSessionRef;
  readonly sessionKey: string;
  readonly attachmentPath: string | null;
  readonly dispatched: boolean;
  readonly sendCount: number;
  readonly outcome: 'pending' | 'sent' | 'failed' | 'ambiguous' | 'cancelled';
  readonly ackId: string | null;
  readonly resolution: { readonly code: string; readonly field: string } | null;
  readonly retryable: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}
interface FanoutView {
  readonly fanoutId: string;
  readonly prompt: string;
  readonly state: string;
  readonly targets: readonly FanoutRecipientView[];
  readonly deduped: number;
  readonly stats: Record<string, number>;
  readonly createdAt: number;
  readonly updatedAt: number;
}
interface SendSpec {
  readonly recipientId: string;
  readonly participantId: string;
  readonly session: FanoutSessionRef;
  readonly attachmentPath: string | null;
}
interface RetainedRecipient {
  readonly recipientId: string;
  readonly outcome: string;
  readonly reason: string;
}
interface RetryPlan {
  readonly retryable: readonly SendSpec[];
  readonly retained: readonly RetainedRecipient[];
}

/* ---------------------------------------------------------------- the real recovery planner */

// The planner is pure ESM, but ships no sibling declaration file, so a static import would be
// TS7016 under the repo's strict vue-tsc gate — the same reason the product's own
// app/runtime/fanout.test.ts reaches fanoutService.js through createRequire, and the same
// `await import` + @ts-ignore boundary app/dev/runtime-v090/task35.ts uses for
// checkpointService.js. The contract is declared above; the code executed is the landed product.
const recoveryModule = await import(
  // @ts-ignore JS module without declarations
  '../../../bridge/runtime/collaboration/fanoutRecovery.js'
) as unknown as { planFanoutRetry(view: FanoutView): RetryPlan };
const { planFanoutRetry } = recoveryModule;

/* ---------------------------------------------------------------- fixtures and capture */

const ENV_A = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
// The five harness kinds of this plan: opencode, codex, kimi-web, dsh, acp.
const H_CODEX = parseHarnessInstanceId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const H_ACP = parseHarnessInstanceId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const H_KIMI = parseHarnessInstanceId('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
const H_DSH = parseHarnessInstanceId('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
const H_OPENCODE = parseHarnessInstanceId('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');

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
domHost.id = 'qa38-out';
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

/** The frozen shared contract every fan-out rejection travels through. */
function tables(): AnyRecord {
  const payload = {
    errorCodes: [...ERROR_CODES],
    errorCodeCount: ERROR_CODES.length,
    errorCodesFrozen: Object.isFrozen(ERROR_CODES),
    collaborationErrorShape: (() => {
      const error = new CollaborationError('conflict', 'fanout_target', { x: 1 });
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
    // The five codes the fan-out service and planner can actually emit, checked in THIS realm.
    coordinationCodesInTable: ['invalid_request', 'conflict', 'cancelled', 'source_unavailable', 'reconcile_required']
      .every((code) => ERROR_CODES.includes(code as never)),
    atExplicit: parseAt(1700000000000),
    atZero: capture(() => parseAt(0)),
    atFractional: capture(() => parseAt(1.5)),
  };
  domHost.textContent = JSON.stringify(payload, null, 2);
  return payload;
}

/**
 * The canonical native-session keys this realm computes for the five harness kinds. The worker
 * asserts these equal the sessionKey values the REAL createFanout wrote into a real fan-out's
 * recipient read models, so a browser window and the bridge worker provably agree on the identity
 * each recipient carries.
 */
function sessionKeys(): AnyRecord {
  const keys = {
    codex: encodeSessionKey(SESSION_CODEX),
    acp: encodeSessionKey(SESSION_ACP),
    kimi: encodeSessionKey(SESSION_KIMI),
    dsh: encodeSessionKey(SESSION_DSH),
    opencode: encodeSessionKey(SESSION_OPENCODE),
    codexDuplicate: encodeSessionKey(session(H_CODEX, 'native:codex-1')),
    decoded: (() => {
      const decoded = decodeSessionKey(encodeSessionKey(SESSION_KIMI));
      return { environmentId: decoded.environmentId, harnessInstanceId: decoded.harnessInstanceId, nativeSessionId: decoded.nativeSessionId };
    })(),
  };
  domHost.textContent = JSON.stringify(keys, null, 2);
  return keys;
}

/**
 * Drives the REAL planFanoutRetry over an OBSERVED fan-out read model. The worker passes in the
 * frozen view the real service produced and runs the same product function over the same bytes;
 * the case asserts the two realms return the identical plan.
 */
function plan(view: FanoutView): AnyRecord {
  const result = planFanoutRetry(view);
  const payload = {
    retryable: result.retryable.map((spec) => ({
      recipientId: spec.recipientId,
      participantId: spec.participantId,
      session: { ...spec.session },
      attachmentPath: spec.attachmentPath,
    })),
    retained: result.retained.map((entry) => ({ recipientId: entry.recipientId, outcome: entry.outcome, reason: entry.reason })),
    frozen: {
      plan: Object.isFrozen(result),
      retryable: Object.isFrozen(result.retryable),
      firstSpec: Object.isFrozen(result.retryable[0]),
      retained: Object.isFrozen(result.retained),
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
  sessionKeys,
  plan,
  codeMembership,
  domText: () => domHost.textContent ?? '',
};

(window as unknown as AnyRecord).task38 = api;
