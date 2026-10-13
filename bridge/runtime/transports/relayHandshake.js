import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { ProtocolError, requireValue, textValue } from '../../../shared/runtime/capabilities.js';

/**
 * Credential-protected handshake for the Slurm compute relay (plan task 29 / Scope 13).
 *
 * The relay is a login-owned long-term step that must only ever be re-attached to the *live*
 * job and *bridge instance* it belongs to. A reconnect therefore binds four things and refuses
 * everything else:
 *
 *  - `intentId`         — the job this relay belongs to (never another operation's job);
 *  - `bridgeInstanceId` — the compute Bridge instance currently serving that job;
 *  - `epoch`            — the fencing epoch of the control store; a requeued job bumps it, so a
 *                         stale relay is answered with `reconcile_required`, not silently adopted;
 *  - `computeNode`/`stepId` — the verified node binding and the specific relay step.
 *
 * Only an HMAC over (kind, binding, nonce) travels in the challenge; the credential never does.
 * The same module also owns the compute-target routing rule that forbids a login fallback: a
 * request whose target is the login node is rejected with an explicit code, never redirected.
 */
export const RELAY_HANDSHAKE_KIND = 'slurm.relay.hello';
export const RELAY_HELLO_ACK_KIND = 'slurm.relay.hello.ack';
export const COMPUTE_OPERATION_KINDS = Object.freeze(['fs', 'git', 'pty', 'driver']);

const BINDING_FIELDS = Object.freeze(['environmentId', 'intentId', 'bridgeInstanceId', 'computeNode', 'stepId']);

const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu;

function uuidField(value, field) {
  requireValue(typeof value === 'string' && UUID.test(value), field);
  return value.toLowerCase();
}

/** Freezes and validates the relay binding. Every field is a stable id, never a URL or a replay. */
export function createRelayBinding(input) {
  requireValue(input !== null && typeof input === 'object' && !Array.isArray(input), 'relay.binding');
  const epoch = input.epoch;
  requireValue(Number.isSafeInteger(epoch) && epoch >= 0, 'relay.epoch');
  return Object.freeze({
    environmentId: uuidField(input.environmentId, 'relay.environmentId'),
    intentId: uuidField(input.intentId, 'relay.intentId'),
    bridgeInstanceId: uuidField(input.bridgeInstanceId, 'relay.bridgeInstanceId'),
    epoch,
    computeNode: textValue(input.computeNode, 'relay.computeNode'),
    stepId: uuidField(input.stepId, 'relay.stepId'),
  });
}

function bindingString(binding) {
  return BINDING_FIELDS.map((field) => `${field}=${binding[field]}`).join('\0') + `\0epoch=${binding.epoch}`;
}

/** Compares a received binding against the expected one, distinguishing an epoch bump from a mismatch. */
export function compareRelayBindings(expected, actual) {
  if (actual === null || typeof actual !== 'object') return Object.freeze({ match: false, reason: 'binding' });
  if (Number(actual.epoch) !== Number(expected.epoch)) return Object.freeze({ match: false, reason: 'epoch' });
  for (const field of BINDING_FIELDS) {
    if (actual[field] !== expected[field]) return Object.freeze({ match: false, reason: 'binding' });
  }
  return Object.freeze({ match: true, reason: null });
}

/**
 * Builds the handshake for one binding. Both ends construct it with the same credential and the
 * same binding; `verify` is a timing-safe comparison of the HMAC plus a binding equality check.
 */
export function createRelayHandshake(options = {}) {
  const credential = textValue(options.credential, 'relay.credential');
  const binding = createRelayBinding(options.binding);
  const token = (nonce) =>
    createHmac('sha256', credential).update(`${RELAY_HANDSHAKE_KIND}\0${bindingString(binding)}\0${nonce}`).digest('hex');
  return Object.freeze({
    kind: RELAY_HANDSHAKE_KIND,
    binding,
    challenge() {
      const nonce = randomUUID();
      return Object.freeze({ kind: RELAY_HANDSHAKE_KIND, nonce, binding, token: token(nonce) });
    },
    ack(nonce) {
      const value = textValue(nonce, 'relay.nonce');
      return Object.freeze({ kind: RELAY_HELLO_ACK_KIND, nonce: value, binding, token: token(value) });
    },
    verify(message) {
      if (message === null || typeof message !== 'object') return false;
      const { nonce, token: presented } = message;
      if (typeof nonce !== 'string' || typeof presented !== 'string') return false;
      if (!compareRelayBindings(binding, message.binding).match) return false;
      const expected = Buffer.from(token(nonce));
      const actual = Buffer.from(presented);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    },
  });
}

/**
 * Structural assertion used after a token check: a matching binding passes, a different job or
 * bridge instance is a `conflict`, and a bumped epoch (a requeued job) is `reconcile_required`.
 */
export function assertRelayHello(options = {}) {
  const expected = createRelayBinding(options.expected);
  const comparison = compareRelayBindings(expected, options.actual);
  if (comparison.match) return true;
  if (comparison.reason === 'epoch') throw new ProtocolError('reconcile_required', 'relay.epoch');
  throw new ProtocolError('conflict', 'relay.binding');
}

/**
 * Asserts that an operation targets the compute node. A login target — either an explicit
 * `kind: 'login'` or a node listed in `loginHosts` — is rejected with `unauthorized`, never
 * silently redirected to a local/login execution.
 */
export function assertComputeTarget(options = {}) {
  const target = options.target;
  const loginHosts = Array.isArray(options.loginHosts) ? options.loginHosts : [];
  requireValue(target !== null && typeof target === 'object' && !Array.isArray(target), 'target');
  if (target.kind === 'login') throw new ProtocolError('unauthorized', 'target.login_fallback');
  if (target.kind !== 'compute') throw new ProtocolError('unsupported', 'target.kind');
  const node = textValue(target.node, 'target.node');
  if (loginHosts.includes(node)) throw new ProtocolError('unauthorized', 'target.login_fallback');
  return Object.freeze({ kind: 'compute', node, environmentId: target.environmentId });
}

/** Routes one FS/Git/PTY/driver operation, proving it lands on the compute node. */
export function routeComputeOperation(kind, options = {}) {
  requireValue(COMPUTE_OPERATION_KINDS.includes(kind), 'operation.kind', 'unsupported');
  const target = assertComputeTarget(options);
  return Object.freeze({ kind, target, host: target.node });
}
