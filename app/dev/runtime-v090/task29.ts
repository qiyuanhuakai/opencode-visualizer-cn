// Task 29 registered QA browser entry — the browser-shaped surface of the Slurm TCP /
// re-connectable step relay: a real Chromium proves the user-visible compute-target routing
// (a login fallback is rejected, never silently redirected), the credential-protected relay
// hello, the allocation reserve / two step-mode argv, and the binary-clean tagged framing.
//
// Loaded by scripts/qa/runtime-v090-cases/task-29.mjs from a runner-served page. The REAL
// landed code executes here:
//   * bridge/runtime/transports/relayHandshake.js — createRelayBinding, createRelayHandshake,
//     assertRelayHello, assertComputeTarget, routeComputeOperation, COMPUTE_OPERATION_KINDS;
//   * bridge/runtime/transports/slurmStepTransport.js — buildAllocationResources,
//     buildStepArgv, assertStepCapabilities, RESERVE_CPUS/RELAY_STEP_*;
//   * bridge/runtime/transports/computeRelay.js — encodeRelayMessage, decodeRelayMessages,
//     RELAY_TAG;
//   * bridge/runtime/transports/processRelay.js — RELAY_MAX_FRAME_BYTES.
// The only controlled boundary is scripts/qa/runtime-v090-cases/task-29-browser-shim.mjs,
// which backs the `node:*` specifiers because a renderer has no OS primitives. The routing /
// handshake / argv / framing LOGIC is real; the OS edge is the worker fixture. This entry
// never contacts a scheduler and never claims a live Slurm verification — task 46 owns that.
import { Buffer as NodeBuffer } from 'buffer';
import {
  COMPUTE_OPERATION_KINDS,
  RELAY_HANDSHAKE_KIND,
  assertComputeTarget,
  assertRelayHello,
  createRelayBinding,
  createRelayHandshake,
  routeComputeOperation,
} from '../../../bridge/runtime/transports/relayHandshake.js';
import {
  RELAY_STEP_CPUS,
  RELAY_STEP_MEMORY_MIB,
  RESERVE_CPUS,
  RESERVE_MEMORY_MIB,
  STEP_CAPABILITIES,
  assertStepCapabilities,
  buildAllocationResources,
  buildStepArgv,
} from '../../../bridge/runtime/transports/slurmStepTransport.js';
import { RELAY_TAG, decodeRelayMessages, encodeRelayMessage } from '../../../bridge/runtime/transports/computeRelay.js';
import { RELAY_MAX_FRAME_BYTES } from '../../../bridge/runtime/transports/processRelay.js';

type AnyRecord = Record<string, any>;

(globalThis as AnyRecord).Buffer = (globalThis as AnyRecord).Buffer ?? NodeBuffer;

const ENVIRONMENT = '11111111-1111-4111-8111-111111111111';
const INTENT = '22222222-2222-4222-8222-222222222222';
const BRIDGE_INSTANCE = '33333333-3333-4333-8333-333333333333';
const STEP_ID = '44444444-4444-4444-8444-444444444444';
const COMPUTE_NODE = 'compute-01.cluster';
const LOGIN_NODE = 'login-01.cluster';

const binding = (overrides: AnyRecord = {}): AnyRecord => createRelayBinding({
  environmentId: ENVIRONMENT, intentId: INTENT, bridgeInstanceId: BRIDGE_INSTANCE, epoch: 3, computeNode: COMPUTE_NODE, stepId: STEP_ID, ...overrides,
});

// ── console spy: prove a credential never reaches any console channel from the renderer ──
const consoleEntries: Array<{ level: string; text: string }> = [];
function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try { return JSON.stringify(value); } catch { return String(value); }
}
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    try { consoleEntries.push({ level, text: args.map(safeString).join(' ') }); } catch { /* capture never throws */ }
    original(...args);
  };
}
const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => { errors.push(`unhandledrejection: ${String((event.reason && (event.reason as AnyRecord).message) || event.reason)}`); });

const domHost = document.createElement('pre');
domHost.id = 'qa29-out';
domHost.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace;padding:8px;';
document.body.append(domHost);

const occurrences = (haystack: string, needle: string): number => (needle.length === 0 ? 0 : haystack.split(needle).length - 1);

/** Captures a typed ProtocolError's code/field without swallowing anything else. */
function capture(run: () => unknown): { code?: string; field?: string } {
  try { run(); return {}; }
  catch (error) {
    if (error && typeof error === 'object') return { code: (error as AnyRecord).code, field: (error as AnyRecord).field };
    return { code: String(error) };
  }
}

// ── BH1: compute-target routing — every FS/Git/PTY/driver targets the compute node; a login fallback is rejected ──
function routing(): AnyRecord {
  const target = { kind: 'compute', node: COMPUTE_NODE, environmentId: ENVIRONMENT };
  const hosts: string[] = [];
  const kinds: string[] = [];
  for (const kind of COMPUTE_OPERATION_KINDS) {
    const route = routeComputeOperation(kind, { target, loginHosts: [LOGIN_NODE] });
    kinds.push(route.kind);
    hosts.push(route.host);
  }
  const loginExplicit = capture(() => assertComputeTarget({ target: { kind: 'login', node: LOGIN_NODE, environmentId: ENVIRONMENT }, loginHosts: [LOGIN_NODE] }));
  const loginByHost = capture(() => routeComputeOperation('fs', { target: { kind: 'compute', node: LOGIN_NODE, environmentId: ENVIRONMENT }, loginHosts: [LOGIN_NODE] }));
  const notCompute = capture(() => assertComputeTarget({ target: { kind: 'local', node: COMPUTE_NODE, environmentId: ENVIRONMENT }, loginHosts: [LOGIN_NODE] }));
  domHost.textContent = JSON.stringify({ kinds, hosts });
  return {
    operationKindCount: COMPUTE_OPERATION_KINDS.length,
    kinds: kinds.join(','),
    hosts: hosts.join(','),
    loginExplicitCode: loginExplicit.code, loginExplicitField: loginExplicit.field,
    loginByHostCode: loginByHost.code, loginByHostField: loginByHost.field,
    notComputeCode: notCompute.code, notComputeField: notCompute.field,
    domLength: domHost.textContent.length,
  };
}

// ── BH2: the credential-protected relay hello never puts the credential on the wire ──
function handshake(credential: string, intentId: string): AnyRecord {
  const session = createRelayHandshake({ credential, binding: binding({ intentId }) });
  const challenge = session.challenge();
  const ack = session.ack(challenge.nonce);
  const attacker = createRelayHandshake({ credential: `${credential}-wrong`, binding: binding({ intentId }) });
  const forged = attacker.challenge();
  const epochMismatch = capture(() => assertRelayHello({ expected: binding({ intentId }), actual: binding({ intentId, epoch: 4 }) }));
  const bindingMismatch = capture(() => assertRelayHello({ expected: binding({ intentId }), actual: binding({ intentId, bridgeInstanceId: '99999999-9999-4999-8999-999999999999' }) }));
  domHost.textContent = JSON.stringify({ kind: challenge.kind, binding: challenge.binding, token: challenge.token });
  const domText = domHost.textContent ?? '';
  return {
    kind: challenge.kind,
    expectedKind: RELAY_HANDSHAKE_KIND,
    ackKind: ack.kind,
    verifyCorrect: session.verify(challenge),
    verifyForgedCredential: session.verify(forged),
    verifyTamperedToken: session.verify({ ...challenge, token: 'deadbeef' }),
    verifyEpochMismatch: session.verify({ ...challenge, binding: binding({ intentId, epoch: 4 }) }),
    epochMismatchCode: epochMismatch.code, epochMismatchField: epochMismatch.field,
    bindingMismatchCode: bindingMismatch.code, bindingMismatchField: bindingMismatch.field,
    tokenHexLength: challenge.token.length,
    nonceLength: challenge.nonce.length,
    credentialInChallengeJson: occurrences(JSON.stringify(challenge), credential),
    credentialInDom: occurrences(domText, credential),
    challengeKeyCount: Object.keys(challenge).length,
  };
}

// ── BH3: the allocation reserve and the two step modes the renderer shows ──
function steps(): AnyRecord {
  const resources = buildAllocationResources({ compute: { cpus: 4, memoryMiB: 8192 }, partition: 'cpu', account: 'research', time: '01:00:00', gres: 'none' });
  const relayArgv = buildStepArgv({ mode: 'relay', bridgeNode: COMPUTE_NODE, jobId: '24680', stepId: STEP_ID, compute: { cpus: 4, memoryMiB: 8192 }, gres: 'none' });
  const serviceArgv = buildStepArgv({ mode: 'service', bridgeNode: COMPUTE_NODE, jobId: '24680', stepId: STEP_ID, compute: { cpus: 4, memoryMiB: 8192 }, gres: 'gpu:1' });
  const capabilityGap = capture(() => assertStepCapabilities({ ...STEP_CAPABILITIES, reserve: false }));
  const tokenCount = (argv: readonly string[], token: string) => argv.filter((entry) => entry === token).length;
  domHost.textContent = JSON.stringify({ resources, relayArgv, serviceArgv });
  return {
    reservedCpus: resources.cpus, reservedMemory: resources.memory,
    reserveCpus: RESERVE_CPUS, reserveMemoryMiB: RESERVE_MEMORY_MIB,
    relayCpus: RELAY_STEP_CPUS, relayMemoryMiB: RELAY_STEP_MEMORY_MIB,
    relayNodelistCount: tokenCount(relayArgv, `--nodelist=${COMPUTE_NODE}`),
    relayCpuCount: tokenCount(relayArgv, '--cpus-per-task=1'),
    relayMemCount: tokenCount(relayArgv, '--mem=128M'),
    relayGresNoneCount: tokenCount(relayArgv, '--gres=none'),
    relayExactCount: tokenCount(relayArgv, '--exact'),
    relayExclusiveCount: tokenCount(relayArgv, '--exclusive'),
    relayParsableCount: relayArgv.filter((entry) => entry.includes('--parsable')).length,
    relayAsyncCount: relayArgv.filter((entry) => entry.includes('--async')).length,
    serviceCpuCount: tokenCount(serviceArgv, '--cpus-per-task=4'),
    serviceMemCount: tokenCount(serviceArgv, '--mem=8192M'),
    serviceGresCount: tokenCount(serviceArgv, '--gres=gpu:1'),
    capabilityGapCode: capabilityGap.code, capabilityGapField: capabilityGap.field,
    domLength: domHost.textContent.length,
  };
}

// ── BH4: the binary-clean tagged framing the relay carries ──
function framing(): AnyRecord {
  const payload = NodeBuffer.from([0x00, 0xff, 0x10, 0x0a, 0x00, 0x7f]);
  const framed = encodeRelayMessage(RELAY_TAG.data, payload);
  const split = Math.floor(framed.length / 2);
  const decoded = decodeRelayMessages(NodeBuffer.concat([framed.subarray(0, split), framed.subarray(split)]));
  const decodedMessage = decoded.messages[0];
  const control = decodeRelayMessages(encodeRelayMessage(RELAY_TAG.control, '{"kind":"ping"}')).messages[0];
  let overrunThrew = false;
  let overrunMessage = '';
  try { encodeRelayMessage(RELAY_TAG.data, NodeBuffer.alloc(RELAY_MAX_FRAME_BYTES + 1)); }
  catch (error) { overrunThrew = true; overrunMessage = String((error as AnyRecord)?.message ?? error); }
  const partial = NodeBuffer.alloc(4 + 10);
  partial.writeUInt32BE(100, 0);
  const partialDecoded = decodeRelayMessages(partial);
  domHost.textContent = JSON.stringify({ tag: decodedMessage?.tag, bytes: decodedMessage?.payload.length });
  return {
    maxFrameBytes: RELAY_MAX_FRAME_BYTES,
    tagData: RELAY_TAG.data, tagControl: RELAY_TAG.control, tagStorageRequest: RELAY_TAG.storageRequest, tagStorageAck: RELAY_TAG.storageAck,
    messageCount: decoded.messages.length,
    decodedTag: decodedMessage?.tag,
    payloadBytes: decodedMessage?.payload.length,
    payloadEqual: NodeBuffer.from(decodedMessage?.payload ?? []).equals(payload),
    remainingBytes: decoded.remaining.length,
    controlTag: control?.tag,
    overrunThrew,
    overrunMessageIncludesTooLarge: overrunMessage.includes('too large'),
    partialFrames: partialDecoded.messages.length,
    partialRemainingBytes: partialDecoded.remaining.length,
    domLength: domHost.textContent.length,
  };
}

const api = {
  ready: true,
  errors: () => errors,
  consoleEntries: () => consoleEntries,
  domText: () => domHost.textContent ?? '',
  routing,
  handshake,
  steps,
  framing,
};

(window as unknown as AnyRecord).task29 = api;
