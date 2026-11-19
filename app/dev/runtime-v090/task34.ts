// Task 34 registered QA browser entry — the cross-realm half of the handoff identity contract.
//
// The product under test is bridge-side and Node-only: bridge/runtime/threads/handoffService.js
// imports createHash and randomUUID from node:crypto (line 1), so the stateful handoff service
// cannot run in a browser realm at all. The registered case therefore drives the REAL handoff
// service (composed with the real Thread and Checkpoint services) in the Node worker, and this
// entry proves the ONE part of the contract that must hold across a process boundary: the identity
// layer the handoff record is built from — the canonical native-session binding key
// (shared/runtime/identity.js encodeSessionKey, consumed by shared/runtime/thread.js
// threadBindingKey), the receiver-side binding parse, the canonical id parses the handoff service
// uses for its thread/participant/handoff ids, and the frozen protocol error-code table every
// handoff rejection code must belong to. The handoff's headline guarantees — the original source
// binding retained, both native sessions preserved across an A→B→A round trip, source and target
// harness instances independent — are only meaningful across windows if the same SessionRef yields
// the same canonical key in a browser JS realm as in the bridge worker; equality here is a real
// claim, and the case asserts the browser keys equal the keys computed from the REAL handoff
// records the worker drives.
//
// Only pure shared modules run here (thread.js / identity.js / capabilities.js); none of them
// touch a node:* builtin and none is a bare or aliased specifier, so NO browser shim is needed
// (task-30 needed one only because the real Icon component fetches from the Iconify API at
// runtime). This entry makes no UI claim (task 35 owns the Thread/handoff UI) and authors no PASS
// verdict.
import {
  ERROR_CODES,
  ProtocolError,
} from '../../../shared/runtime/capabilities.js';
import {
  parseThreadId,
  parseParticipantId,
  threadBindingKey,
  parseThreadBinding,
} from '../../../shared/runtime/thread.js';
import {
  decodeSessionKey,
  encodeSessionKey,
  parseSessionRef,
} from '../../../shared/runtime/identity.js';
import type { SessionRef } from '../../../shared/runtime/identity.js';

type AnyRecord = Record<string, any>;

const ENV_A = '11111111-1111-4111-8111-111111111111';
const H_CODEX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const H_ACP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const H_KIMI = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// Built through the real parseSessionRef so each ref IS the frozen SessionRef the handoff record carries.
const session = (harness: string, nativeSessionId: string): SessionRef =>
  parseSessionRef({ environmentId: ENV_A, harnessInstanceId: harness, nativeSessionId });
const SESSION_CODEX = session(H_CODEX, 'native:codex-1');
const SESSION_ACP = session(H_ACP, 'native:acp-1');
const SESSION_KIMI = session(H_KIMI, 'native:kimi-1');

const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => { errors.push(`unhandledrejection: ${String((event.reason && (event.reason as AnyRecord).message) || event.reason)}`); });

const domHost = document.createElement('pre');
domHost.id = 'qa34-out';
domHost.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace;padding:8px;';
document.body.append(domHost);

/**
 * Captures a typed ProtocolError's code/field without swallowing anything else. The SAME envelope
 * is emitted on EVERY path, success included (the task-32/33 lesson): { code: null, field: null }
 * on success, so the worker's capture and this one are comparable key-for-key.
 */
function capture(run: () => unknown): { code: string | null; field: string | null } {
  try { run(); return { code: null, field: null }; }
  catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && 'field' in error) {
      const record = error as AnyRecord;
      if (typeof record.code === 'string' && typeof record.field === 'string') return { code: record.code, field: record.field };
    }
    return { code: 'not-a-ProtocolError', field: String(error) };
  }
}

/** The frozen protocol error-code table every handoff rejection code must belong to. */
function tables(): AnyRecord {
  domHost.textContent = JSON.stringify({ codes: [...ERROR_CODES] }, null, 2);
  return {
    errorCodes: [...ERROR_CODES],
    errorCodeCount: ERROR_CODES.length,
    errorCodesFrozen: Object.isFrozen(ERROR_CODES),
    // The handoff module's own codes, checked against the canonical table in THIS realm.
    handoffCodesInTable: ['invalid_request', 'conflict', 'cancelled', 'unauthorized', 'source_unavailable', 'reconcile_required']
      .every((code) => ERROR_CODES.includes(code as never)),
    protocolErrorShape: (() => {
      const error = new ProtocolError('conflict', 'handoff_state');
      return { name: error.name, code: error.code, field: error.field, message: error.message, isTypeError: error instanceof TypeError };
    })(),
  };
}

/**
 * The canonical binding keys this realm computes for the three handoff sessions. The worker
 * asserts these equal the keys it computes from the REAL handoff records, so a browser window and
 * the bridge worker provably agree on native-session identity.
 */
function bindingKeys(): AnyRecord {
  const keys = {
    codex: threadBindingKey(SESSION_CODEX),
    acp: threadBindingKey(SESSION_ACP),
    kimi: threadBindingKey(SESSION_KIMI),
    codexDuplicate: threadBindingKey(session(H_CODEX, 'native:codex-1')),
    sessionKeyCodex: encodeSessionKey(SESSION_CODEX),
    sessionKeyAcp: encodeSessionKey(SESSION_ACP),
    sessionKeyKimi: encodeSessionKey(SESSION_KIMI),
  };
  domHost.textContent = JSON.stringify(keys, null, 2);
  return keys;
}

/** The canonical key round-trips back to the exact referenced native session. */
function decode(key: string): AnyRecord {
  const decoded = decodeSessionKey(key);
  return {
    environmentId: decoded.environmentId,
    harnessInstanceId: decoded.harnessInstanceId,
    nativeSessionId: decoded.nativeSessionId,
  };
}

/** The receiver-side binding parse preserves the referenced session and its native parent. */
function binding(): AnyRecord {
  const parent = session(H_CODEX, 'native:parent');
  const parsed = parseThreadBinding({ role: 'participant', session: SESSION_CODEX, nativeParent: parent } as never);
  const ownerNull = parseThreadBinding({ role: 'owner', session: SESSION_CODEX, nativeParent: null } as never);
  domHost.textContent = JSON.stringify({ role: parsed.role, nativeParent: parsed.nativeParent, malformed: capture(() => parseThreadBinding({ role: 'participant', session: SESSION_CODEX } as never)) }, null, 2);
  return {
    role: parsed.role,
    session: { environmentId: parsed.session.environmentId, harnessInstanceId: parsed.session.harnessInstanceId, nativeSessionId: parsed.session.nativeSessionId },
    nativeParent: parsed.nativeParent === null ? null : { environmentId: parsed.nativeParent.environmentId, harnessInstanceId: parsed.nativeParent.harnessInstanceId, nativeSessionId: parsed.nativeParent.nativeSessionId },
    ownerNativeParent: ownerNull.nativeParent,
    sessionFrozen: Object.isFrozen(parsed.session),
    bindingFrozen: Object.isFrozen(parsed),
    malformed: capture(() => parseThreadBinding({ role: 'participant', session: SESSION_CODEX } as never)),
  };
}

/** Canonical UUID normalization and the id rejections are engine-independent too. */
function identity(): AnyRecord {
  const refs = { codex: parseSessionRef(SESSION_CODEX), acp: parseSessionRef(SESSION_ACP), kimi: parseSessionRef(SESSION_KIMI) };
  domHost.textContent = JSON.stringify({ threadId: parseThreadId('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA') }, null, 2);
  return {
    sessions: {
      codex: { environmentId: refs.codex.environmentId, harnessInstanceId: refs.codex.harnessInstanceId, nativeSessionId: refs.codex.nativeSessionId },
      acp: { environmentId: refs.acp.environmentId, harnessInstanceId: refs.acp.harnessInstanceId, nativeSessionId: refs.acp.nativeSessionId },
      kimi: { environmentId: refs.kimi.environmentId, harnessInstanceId: refs.kimi.harnessInstanceId, nativeSessionId: refs.kimi.nativeSessionId },
    },
    sessionsFrozen: [Object.isFrozen(refs.codex), Object.isFrozen(refs.acp), Object.isFrozen(refs.kimi)],
    threadId: parseThreadId('AB123456-1234-4123-8123-123456789ABC'),
    participantId: parseParticipantId('CD123456-1234-4123-8123-123456789ABC'),
    badThreadId: capture(() => parseThreadId('nope')),
    badParticipantId: capture(() => parseParticipantId('nope')),
  };
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
  bindingKeys,
  decode,
  binding,
  identity,
  codeMembership,
  domText: () => domHost.textContent ?? '',
};

(window as unknown as AnyRecord).task34 = api;
