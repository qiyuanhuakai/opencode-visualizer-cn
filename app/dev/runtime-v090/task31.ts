// Task 31 registered QA browser entry — the cross-environment half of the Host
// Thread binding contract.
//
// The product under test is bridge-side and Node-only (bridge/runtime/threads/*),
// so the registered case drives the REAL ThreadService / ParticipantService in the
// Node worker. This entry proves the ONE part of the contract that must hold across
// a process boundary: the canonical binding key (shared/runtime/identity.js
// encodeSessionKey, consumed by shared/runtime/thread.js threadBindingKey) and the
// receiver-side binding parse (shared/runtime/thread.js parseThreadBinding). Two
// windows that bind the same native SessionRef can only land on the SAME wrapper if
// they compute the SAME canonical key; a browser JS realm is a different execution
// environment from the bridge worker, so equality here is a real claim.
//
// Only pure shared modules run here (thread.js / identity.js / capabilities.js);
// none of them touch a node:* builtin — no browser shim is needed. This entry makes
// no UI claim and authors no PASS verdict.
import {
  PARTICIPANT_STATES,
  THREAD_ROLES,
  parseParticipantId,
  parseThreadBinding,
  parseThreadId,
  parseThreadRole,
  threadBindingKey,
} from '../../../shared/runtime/thread.js';
import { decodeSessionKey, parseEnvironmentId, parseHarnessInstanceId } from '../../../shared/runtime/identity.js';

type AnyRecord = Record<string, any>;

const ENV_A = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const HARNESS_A = parseHarnessInstanceId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const HARNESS_B = parseHarnessInstanceId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

const ref = (harness: string, nativeSessionId: string): AnyRecord => ({ environmentId: ENV_A, harnessInstanceId: harness, nativeSessionId });

const REF_5 = ref(HARNESS_A, 'native:5');
const REF_SIBLING = ref(HARNESS_A, 'native:6');
const REF_OTHER_HARNESS = ref(HARNESS_B, 'native:5');
const REF_PARENT = ref(HARNESS_A, 'native:parent');

const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => { errors.push(`unhandledrejection: ${String((event.reason && (event.reason as AnyRecord).message) || event.reason)}`); });

const domHost = document.createElement('pre');
domHost.id = 'qa31-out';
domHost.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace;padding:8px;';
document.body.append(domHost);

/** Captures a typed ThreadError's code/field without swallowing anything else. */
function capture(run: () => unknown): { code?: string; field?: string } {
  try { run(); return {}; }
  catch (error) {
    if (error && typeof error === 'object') return { code: (error as AnyRecord).code, field: (error as AnyRecord).field };
    return { code: String(error) };
  }
}

// ── canonical binding keys the browser computes for the fixed SessionRefs ──
function bindingKeys(): AnyRecord {
  const keys = {
    ref5: threadBindingKey(REF_5),
    duplicate: threadBindingKey(ref(HARNESS_A, 'native:5')),
    sibling: threadBindingKey(REF_SIBLING),
    otherHarness: threadBindingKey(REF_OTHER_HARNESS),
  };
  domHost.textContent = JSON.stringify(keys, null, 2);
  return keys;
}

// ── the canonical key round-trips back to the exact referenced native session ──
function decode(key: string): AnyRecord {
  const session = decodeSessionKey(key);
  domHost.textContent = JSON.stringify(session, null, 2);
  return { environmentId: session.environmentId, harnessInstanceId: session.harnessInstanceId, nativeSessionId: session.nativeSessionId };
}

// ── the receiver-side binding parse preserves the native parent (sub-agent) ──
function binding(): AnyRecord {
  const parsed = parseThreadBinding({ role: 'participant', session: REF_5, nativeParent: REF_PARENT });
  const ownerNull = parseThreadBinding({ role: 'owner', session: REF_5, nativeParent: null });
  const malformed = capture(() => parseThreadBinding({ role: 'participant', session: REF_5 }));
  domHost.textContent = JSON.stringify({ parsed, ownerNativeParent: ownerNull.nativeParent, malformed }, null, 2);
  return {
    role: parsed.role,
    session: { environmentId: parsed.session.environmentId, harnessInstanceId: parsed.session.harnessInstanceId, nativeSessionId: parsed.session.nativeSessionId },
    nativeParent: { environmentId: parsed.nativeParent?.environmentId, harnessInstanceId: parsed.nativeParent?.harnessInstanceId, nativeSessionId: parsed.nativeParent?.nativeSessionId },
    ownerNativeParent: ownerNull.nativeParent,
    malformed,
  };
}

// ── the fixed role table and the role rejection, observed in the browser ──
function roles(): AnyRecord {
  const rejection = capture(() => parseThreadRole('observer'));
  domHost.textContent = JSON.stringify({ roles: THREAD_ROLES, states: PARTICIPANT_STATES, rejection }, null, 2);
  return {
    roles: [...THREAD_ROLES],
    states: [...PARTICIPANT_STATES],
    owner: parseThreadRole('owner'),
    participant: parseThreadRole('participant'),
    rejection,
  };
}

// ── canonical UUID normalization is engine-independent too ──
function identity(): AnyRecord {
  const threadId = parseThreadId('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA');
  const participantId = parseParticipantId('BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB');
  domHost.textContent = JSON.stringify({ threadId, participantId }, null, 2);
  return { threadId, participantId };
}

const api = {
  ready: true,
  errors: () => errors,
  bindingKeys,
  decode,
  binding,
  roles,
  identity,
  domText: () => domHost.textContent ?? '',
};

(window as unknown as AnyRecord).task31 = api;
