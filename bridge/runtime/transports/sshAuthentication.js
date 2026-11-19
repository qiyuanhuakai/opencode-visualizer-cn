import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ProtocolError, requireValue } from '../../../shared/runtime/capabilities.js';
import { evaluateHostKey } from './knownHosts.js';

/**
 * Challenge-based SSH authentication. Secrets (first-trust confirmation, password, OTP,
 * passphrase) are only ever requested through a challenge and answered out of band; they never
 * become a command-line argument. A secret is held in a single-use `SecretBox` whose string and
 * JSON projections are redacted, so an accidental log or `JSON.stringify` cannot leak it.
 */
export const AUTH_CHALLENGE_KINDS = Object.freeze([
  'host-key',
  'host-key-changed',
  'password',
  'passphrase',
  'otp',
  'keyboard-interactive',
]);
export const REDACTED = '[redacted]';

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

export function redactSecrets(value, secrets = []) {
  let text = typeof value === 'string' ? value : String(value);
  for (const secret of secrets) {
    const raw = typeof secret === 'string' ? secret : secret instanceof Object ? String(secret) : '';
    if (raw.length > 0 && raw !== REDACTED) text = text.split(raw).join(REDACTED);
  }
  return text;
}

/** A secret that can be consumed exactly once and is redacted in every projection. */
export function createSecretBox(secret, label = 'secret') {
  requireValue(typeof secret === 'string' && secret.length > 0, 'secret');
  let consumed = false;
  return Object.freeze({
    label,
    get size() {
      return Buffer.byteLength(secret, 'utf8');
    },
    consume() {
      if (consumed) throw new ProtocolError('conflict', 'secret.consumed');
      consumed = true;
      return secret;
    },
    toString() {
      return REDACTED;
    },
    toJSON() {
      return REDACTED;
    },
    [INSPECT]() {
      return REDACTED;
    },
  });
}

/**
 * Delivers a secret to ssh's askpass helper through a 0600 file whose *path* (never the value)
 * travels in the environment. argv stays secret-free on every platform.
 */
export async function createSecretChannel(secrets, options = {}) {
  const values = (secrets ?? []).map((secret) => (typeof secret === 'string' ? secret : secret?.consume?.() ?? ''));
  if (values.length === 0) {
    return Object.freeze({ env: Object.freeze({}), filePath: undefined, async cleanup() {} });
  }
  const directory = options.directory ?? tmpdir();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(directory, `vis-ssh-secret-${randomUUID()}`);
  await writeFile(filePath, values.join('\n'), { encoding: 'utf8', mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => {});
  const env = Object.freeze({
    SSH_ASKPASS: options.askpassPath ?? 'ssh-askpass',
    SSH_ASKPASS_REQUIRE: 'force',
    VIS_SSH_ASKPASS_FILE: filePath,
    DISPLAY: options.display ?? ':0',
  });
  return Object.freeze({
    env,
    filePath,
    async cleanup() {
      await rm(filePath, { force: true });
    },
  });
}

const SECRET_METHODS = Object.freeze({
  password: Object.freeze({ challenge: 'password', prompt: 'password' }),
  'keyboard-interactive': Object.freeze({ challenge: 'otp', prompt: 'one-time code' }),
  otp: Object.freeze({ challenge: 'otp', prompt: 'one-time code' }),
});

function secretBoxFrom(answer) {
  const value = typeof answer === 'string' ? answer : answer?.secret;
  if (typeof value !== 'string' || value.length === 0) throw new ProtocolError('unauthorized', 'auth.secret');
  return createSecretBox(value);
}

export function createAuthenticationSession(options = {}) {
  const host = String(options.host ?? '');
  const port = options.port ?? 22;
  const knownHosts = options.knownHosts ?? [];
  const hostKey = options.hostKey ?? {};
  const method = options.method ?? 'publickey';
  const responder = options.responder;
  const now = options.now ?? (() => Date.now());
  const passphraseRequired = options.passphraseRequired ?? method === 'publickey';
  let cancelled = false;
  let pending;

  async function ask(kind, prompt, extra = {}) {
    requireValue(typeof responder === 'function', 'auth.responder');
    requireValue(!cancelled, 'auth', 'cancelled');
    const challenge = Object.freeze({
      challengeId: randomUUID(),
      kind,
      prompt,
      echo: false,
      redacted: true,
      createdAt: now(),
      ...extra,
    });
    pending = challenge;
    const answer = await responder(challenge);
    pending = undefined;
    requireValue(!cancelled, 'auth', 'cancelled');
    return answer;
  }

  async function resolveHostKey() {
    const evaluation = evaluateHostKey(knownHosts, { host, port, keyType: hostKey.keyType, keyBlob: hostKey.keyBlob });
    if (evaluation.status === 'revoked') throw new ProtocolError('unauthorized', 'host.key.revoked');
    if (evaluation.status === 'changed') {
      await ask('host-key-changed', `REMOTE HOST IDENTIFICATION HAS CHANGED for ${host} (${evaluation.fingerprint})`, {
        fingerprint: evaluation.fingerprint,
        options: Object.freeze(['reject']),
      });
      throw new ProtocolError('unauthorized', 'host.key.changed');
    }
    if (evaluation.status === 'unknown') {
      const answer = await ask('host-key', `The authenticity of host '${host}' can't be established (${evaluation.fingerprint}).`, {
        fingerprint: evaluation.fingerprint,
        options: Object.freeze(['accept', 'reject']),
      });
      if (answer?.accept !== true) throw new ProtocolError('unauthorized', 'host.key.untrusted');
      if (answer.persist === true) {
        return Object.freeze({ status: evaluation.status, fingerprint: evaluation.fingerprint, knownHostEntry: Object.freeze({ host, port, keyType: hostKey.keyType, keyBlob: hostKey.keyBlob }) });
      }
    }
    return Object.freeze({ status: evaluation.status, fingerprint: evaluation.fingerprint });
  }

  async function resolveSecrets() {
    const secrets = [];
    const methods = [];
    const description = SECRET_METHODS[method];
    if (description !== undefined) {
      methods.push(method);
      secrets.push(secretBoxFrom(await ask(description.challenge, `${description.prompt[0].toUpperCase()}${description.prompt.slice(1)} for ${options.user ? `${options.user}@` : ''}${host}:`)));
      return { methods, secrets };
    }
    methods.push('publickey');
    if (passphraseRequired) {
      const answer = await ask('passphrase', `Enter passphrase for key (${host}):`);
      if (typeof answer?.secret === 'string' && answer.secret.length > 0) secrets.push(secretBoxFrom(answer));
    }
    return { methods, secrets };
  }

  async function authenticate() {
    const hostKeyResult = await resolveHostKey();
    const { methods, secrets } = await resolveSecrets();
    return Object.freeze({
      hostKeyStatus: hostKeyResult.status,
      hostKeyFingerprint: hostKeyResult.fingerprint,
      ...(hostKeyResult.knownHostEntry === undefined ? {} : { knownHostEntry: hostKeyResult.knownHostEntry }),
      methods: Object.freeze(methods),
      secrets: Object.freeze(secrets),
    });
  }

  function cancel() {
    cancelled = true;
    pending = undefined;
  }

  return Object.freeze({
    authenticate,
    cancel,
    get pending() {
      return pending;
    },
  });
}
