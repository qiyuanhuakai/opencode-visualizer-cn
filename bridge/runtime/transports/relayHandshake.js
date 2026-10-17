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
 * The handshake is mutual and every leg is domain-separated: the HMAC input carries the message
 * kind, so a token minted for the hello can never verify as the ack, and an ack minted for one
 * connection's challenge can never verify as another connection's. Only HMACs over
 * (kind, binding, nonce[, peer challenge]) travel on the wire; the credential never does. The
 * login proves possession by answering the compute side's fresh challenge, and the compute side
 * proves possession by answering the login's — a reflected or replayed message proves nothing.
 * The same module also owns the compute-target routing rule that forbids a login fallback: a
 * request whose target is the login node is rejected with an explicit code, never redirected.
 */
export const RELAY_HANDSHAKE_KIND = 'slurm.relay.hello';
export const RELAY_HELLO_ACK_KIND = 'slurm.relay.hello.ack';
export const RELAY_HELLO_CONFIRM_KIND = 'slurm.relay.hello.confirm';
export const RELAY_HANDSHAKE_KINDS = Object.freeze([RELAY_HANDSHAKE_KIND, RELAY_HELLO_ACK_KIND, RELAY_HELLO_CONFIRM_KIND]);
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
 * same binding. Every message kind has its own HMAC domain, so `verify` dispatches on the
 * message's own kind: a hello token never verifies as an ack and vice versa, which is what makes
 * a kind-flipped reflection worthless. The ack and the confirm additionally bind the compute
 * side's fresh challenge, so a captured leg of one connection can never be replayed on another.
 * `verify` is a timing-safe comparison of the HMAC plus a binding equality check.
 */
export function createRelayHandshake(options = {}) {
  const credential = textValue(options.credential, 'relay.credential');
  const binding = createRelayBinding(options.binding);
  const token = (kind, nonce, challenge) => {
    const input =
      challenge === undefined
        ? `${kind}\0${bindingString(binding)}\0${nonce}`
        : `${kind}\0${bindingString(binding)}\0${nonce}\0${challenge}`;
    return createHmac('sha256', credential).update(input).digest('hex');
  };
  return Object.freeze({
    kind: RELAY_HANDSHAKE_KIND,
    binding,
    challenge() {
      const nonce = randomUUID();
      return Object.freeze({ kind: RELAY_HANDSHAKE_KIND, nonce, binding, token: token(RELAY_HANDSHAKE_KIND, nonce) });
    },
    ack(nonce) {
      const value = textValue(nonce, 'relay.nonce');
      // The compute side answers the login's challenge with a fresh challenge of its own; the
      // login must prove the credential again over it before the compute side is ready.
      const challenge = randomUUID();
      return Object.freeze({
        kind: RELAY_HELLO_ACK_KIND,
        nonce: value,
        challenge,
        binding,
        token: token(RELAY_HELLO_ACK_KIND, value, challenge),
      });
    },
    confirm(nonce, challenge) {
      const value = textValue(nonce, 'relay.nonce');
      const peer = textValue(challenge, 'relay.challenge');
      return Object.freeze({
        kind: RELAY_HELLO_CONFIRM_KIND,
        nonce: value,
        challenge: peer,
        binding,
        token: token(RELAY_HELLO_CONFIRM_KIND, value, peer),
      });
    },
    verify(message) {
      if (message === null || typeof message !== 'object') return false;
      const { kind, nonce, challenge, token: presented } = message;
      if (typeof nonce !== 'string' || typeof presented !== 'string') return false;
      // An unknown or absent kind has no domain and can never verify.
      if (!RELAY_HANDSHAKE_KINDS.includes(kind)) return false;
      if (kind !== RELAY_HANDSHAKE_KIND && typeof challenge !== 'string') return false;
      if (!compareRelayBindings(binding, message.binding).match) return false;
      const expected = Buffer.from(token(kind, nonce, kind === RELAY_HANDSHAKE_KIND ? undefined : challenge));
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
