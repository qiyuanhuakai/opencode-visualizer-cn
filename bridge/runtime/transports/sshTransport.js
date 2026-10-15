import { readFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';

import { ProtocolError, requireValue } from '../../../shared/runtime/capabilities.js';
import { resolveProfileEnvironment } from '../../../shared/runtime/connectionProfile.js';
import { parseKnownHosts } from './knownHosts.js';
import { createProcessRelay, decodeRelayFrames, encodeRelayFrame } from './processRelay.js';
import { createAuthenticationSession, createSecretChannel } from './sshAuthentication.js';

/**
 * System SSH transport. It hands ssh a *structured* argument vector (never a concatenated shell
 * string), honours `ssh_config` / `known_hosts` / `ProxyJump`, and keeps formal traffic on a
 * loopback forward with no PTY. Readiness is gated on a target hello, not on ssh's forward-setup
 * success, and agent forwarding is off unless the caller explicitly opts in.
 */
const SSH_PROGRAMS = Object.freeze({ win32: 'ssh.exe', darwin: 'ssh', linux: 'ssh' });
export const TARGET_HELLO = Object.freeze({ kind: 'target.hello', version: 1 });
export const TARGET_HELLO_OK = Object.freeze({ kind: 'target.hello.ok', version: 1 });
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const DEFAULT_HELLO_TIMEOUT_MS = 5_000;
const MAX_FORWARD_ATTEMPTS = 3;
// A refused connect means "the forward is not listening yet", which is retryable; the pause keeps
// the retry loop from hammering the loopback port while OpenSSH is still establishing the session.
const HELLO_RETRY_DELAY_MS = 25;

export function sshProgram(platform = process.platform) {
  return SSH_PROGRAMS[platform] ?? 'ssh';
}

function parseEndpoint(endpoint) {
  const text = String(endpoint);
  const bracketed = /^\[([^\]]+)\]:(\d+)$/u.exec(text);
  if (bracketed !== null) return { host: bracketed[1], port: Number(bracketed[2]) };
  const index = text.lastIndexOf(':');
  if (index > 0 && /^\d+$/u.test(text.slice(index + 1))) {
    return { host: text.slice(0, index), port: Number(text.slice(index + 1)) };
  }
  return { host: text, port: 22 };
}

function escapeRegExpCharacter(character) {
  return character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
function globMatches(pattern, host) {
  let source = '^';
  for (const character of pattern.toLowerCase()) {
    if (character === '*') source += '.*';
    else if (character === '?') source += '.';
    else source += escapeRegExpCharacter(character);
  }
  return new RegExp(`${source}$`, 'u').test(host);
}
function blockApplies(block, host) {
  let positive = false;
  for (const pattern of block.patterns) {
    if (pattern.startsWith('!')) {
      if (globMatches(pattern.slice(1), host)) return false;
    } else if (globMatches(pattern, host)) {
      positive = true;
    }
  }
  return positive;
}

/** Parses `ssh_config` into `Host` blocks preserving keyword order for first-match-wins. */
export function parseSshConfig(text) {
  const blocks = [];
  let current;
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/#.*$/u, '').trim();
    if (line === '') continue;
    const match = /^([A-Za-z][A-Za-z0-9]*)[\s=]+(.*)$/u.exec(line);
    if (match === null) continue;
    const keyword = match[1].toLowerCase();
    const value = match[2].trim();
    if (keyword === 'host') {
      current = { patterns: value.split(/\s+/u).filter((pattern) => pattern.length > 0), options: new Map() };
      blocks.push(current);
      continue;
    }
    if (current === undefined || value === '') continue;
    if (!current.options.has(keyword)) current.options.set(keyword, []);
    current.options.get(keyword).push(value);
  }
  return blocks;
}

const FIRST_VALUE_OPTION = Object.freeze({
  hostname: 'hostName',
  user: 'user',
  proxyjump: 'proxyJump',
  proxycommand: 'proxyCommand',
  stricthostkeychecking: 'strictHostKeyChecking',
  userknownhostsfile: 'userKnownHostsFile',
  forwardagent: 'forwardAgent',
  requesttty: 'requestTTY',
});

/** Resolves the effective options for `host` with OpenSSH first-obtained-value semantics. */
export function resolveSshConfig(configText, host) {
  const blocks = Array.isArray(configText) ? configText : parseSshConfig(configText);
  const lowerHost = String(host).toLowerCase();
  const result = {
    hostName: undefined,
    user: undefined,
    port: undefined,
    identityFiles: [],
    proxyJump: undefined,
    proxyCommand: undefined,
    strictHostKeyChecking: undefined,
    userKnownHostsFile: undefined,
    forwardAgent: undefined,
    requestTTY: undefined,
  };
  for (const block of blocks) {
    if (!blockApplies(block, lowerHost)) continue;
    for (const [keyword, values] of block.options) {
      const field = FIRST_VALUE_OPTION[keyword];
      if (field !== undefined) {
        if (result[field] === undefined) result[field] = values[0];
      } else if (keyword === 'port' && result.port === undefined) {
        const port = Number(values[0]);
        if (Number.isInteger(port) && port > 0) result.port = port;
      } else if (keyword === 'identityfile') {
        for (const value of values) result.identityFiles.push(value);
      }
    }
  }
  return Object.freeze({ ...result, identityFiles: Object.freeze(result.identityFiles) });
}

/** Resolves an endpoint alias through ssh_config into a concrete connect target. */
export function resolveSshTarget(input = {}) {
  const parsed = input.endpoint === undefined
    ? { host: input.host ?? 'localhost', port: input.port ?? 22 }
    : parseEndpoint(input.endpoint);
  const resolved = input.configText === undefined ? {} : resolveSshConfig(input.configText, parsed.host);
  const port = Number(resolved.port ?? input.port ?? parsed.port ?? 22);
  return Object.freeze({
    alias: parsed.host,
    host: resolved.hostName ?? input.hostName ?? parsed.host,
    port: Number.isInteger(port) && port > 0 ? port : 22,
    user: resolved.user ?? input.user,
    identityFiles: Object.freeze(resolved.identityFiles ?? input.identityFiles ?? []),
    proxyJump: resolved.proxyJump ?? input.proxyJump,
    proxyCommand: resolved.proxyCommand ?? input.proxyCommand,
    strictHostKeyChecking: resolved.strictHostKeyChecking ?? input.strictHostKeyChecking,
    userKnownHostsFile: resolved.userKnownHostsFile ?? input.userKnownHostsFile,
    forwardAgent: resolved.forwardAgent,
    requestTTY: resolved.requestTTY,
  });
}

/** Rejects any token that a shell would reinterpret (NUL/CR/LF); argv is otherwise safe as-is. */
export function assertNoShellConcatenation(tokens) {
  requireValue(Array.isArray(tokens), 'argv');
  for (const token of tokens) {
    requireValue(typeof token === 'string' && token.length > 0, 'argv.token');
    requireValue(!/[\0\r\n]/u.test(token), 'argv.shell_unsafe');
  }
  return tokens;
}

export function assertSecretFreeArgv(argv, secrets = []) {
  for (const token of argv) {
    for (const secret of secrets) {
      const raw = typeof secret === 'string' ? secret : '';
      if (raw.length > 0 && token.includes(raw)) throw new ProtocolError('invalid_request', 'argv.secret');
    }
  }
  return argv;
}

/**
 * Builds the structured ssh argument vector. Secrets are deliberately absent: they travel
 * through the askpass channel, never argv. `-T`/`RequestTTY=no` means no PTY, `ForwardAgent=no`
 * turns off agent forwarding, and `-L 127.0.0.1:<allocated>:…` forwards a concrete loopback port.
 */
export function buildSshArgv(options = {}) {
  const target = options.target ?? {};
  const platform = options.platform ?? process.platform;
  const argv = ['-T', '-o', 'RequestTTY=no', '-o', 'ForwardAgent=no', '-o', 'ExitOnForwardFailure=yes', '-o', 'IdentitiesOnly=yes'];
  const strict = options.strictHostKeyChecking ?? target.strictHostKeyChecking ?? 'yes';
  argv.push('-o', `StrictHostKeyChecking=${strict}`);
  const knownHostsFile = options.knownHostsFile ?? target.userKnownHostsFile;
  if (knownHostsFile !== undefined) argv.push('-o', `UserKnownHostsFile=${knownHostsFile}`);
  argv.push('-o', `ConnectTimeout=${options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS}`);
  argv.push('-o', `ServerAliveInterval=${options.serverAliveInterval ?? 15}`);
  if (options.configPath !== undefined) argv.push('-F', options.configPath);
  for (const identity of options.identityFiles ?? target.identityFiles ?? []) argv.push('-i', identity);
  if (target.proxyJump !== undefined) argv.push('-J', target.proxyJump);
  if (target.port !== undefined && Number(target.port) !== 22) argv.push('-p', String(target.port));
  if (target.user !== undefined) argv.push('-l', target.user);
  if (options.forward !== undefined) {
    const forward = options.forward;
    // OpenSSH's -L grammar rejects port 0 ("Bad local forwarding specification"), so the caller
    // must allocate a concrete loopback port; a dynamic port cannot be requested through -L.
    requireValue(
      Number.isInteger(forward.localPort) && forward.localPort > 0 && forward.localPort <= 65535,
      'forward.localPort',
    );
    argv.push('-L', `${forward.localHost ?? '127.0.0.1'}:${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`);
    argv.push('-N');
  }
  argv.push('--', target.host);
  assertNoShellConcatenation([options.program ?? sshProgram(platform), ...argv]);
  return Object.freeze(argv);
}

export function buildSshEnvironment(options = {}) {
  return Object.freeze({ ...(options.base ?? process.env), ...options.channel?.env });
}

export function parseAllocatedPort(text) {
  const match = /Allocated port (\d+) for (?:forward|remote forward)/u.exec(String(text ?? ''));
  return match === null ? undefined : Number(match[1]);
}

function methodForCredential(credentialRef) {
  const reference = String(credentialRef ?? '');
  if (/password/u.test(reference)) return 'password';
  if (/(otp|totp|mfa|keyboard)/u.test(reference)) return 'keyboard-interactive';
  return 'publickey';
}

async function loadOptionalFile(filePath) {
  if (filePath === undefined) return '';
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function defaultKnownHostsPath() {
  return path.join(homedir(), '.ssh', 'known_hosts');
}

function defaultHostKeyProvider() {
  throw new ProtocolError('source_unavailable', 'host.key');
}

/**
 * Reserves a free loopback port for the local forward and releases it immediately so ssh can bind
 * it. The OS allocation is the only way to get a dynamic -L port; ssh's own "Allocated port …
 * for forward" receipt is not emitted for a local forward and must not be relied on.
 */
function defaultAllocateLocalPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', () => reject(new ProtocolError('source_unavailable', 'forward.port')));
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : undefined;
      probe.close((closeError) => {
        if (closeError !== undefined || !Number.isInteger(port) || port <= 0) {
          reject(new ProtocolError('source_unavailable', 'forward.port'));
          return;
        }
        resolve(port);
      });
    });
  });
}

function childHasExited(child) {
  if (child === undefined || child === null) return false;
  const exited = child.exitCode !== null && child.exitCode !== undefined;
  const signalled = child.signalCode !== null && child.signalCode !== undefined;
  return exited || signalled;
}

/**
 * Resolves the forward outcome: readiness only when the target hello confirms, plus an immediate
 * rejection if the spawn itself fails (ENOENT/EACCES) or the process exits before readiness.
 *
 * `helloTimeoutMs` is the TOTAL readiness budget. OpenSSH binds the local forward only once the
 * SSH session (and the remote side of the forward) is up, so a connect that lands first is
 * REFUSED rather than slow: that is "not listening yet", not a failed forward. A refused connect
 * is therefore retried inside the same budget while the child is still alive and nothing has
 * cancelled the dial. Every other hello result — a target that accepted the connection and then
 * stayed silent, a parse failure, a child exit, a spawn error — settles immediately.
 */
function awaitForward({ relay, spawned, targetHello, helloTimeoutMs, localPort }) {
  return new Promise((resolve) => {
    let settled = false;
    const controller = new AbortController();
    const deadline = Date.now() + helloTimeoutMs;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      // Cancel an in-flight hello once the process has failed or exited, so its socket and
      // ready-timeout timer cannot keep the host event loop alive after a failed dial.
      if (outcome.kind === 'spawn-error' || outcome.kind === 'exit') controller.abort();
      resolve(outcome);
    };
    if (typeof relay.onError === 'function') relay.onError(spawned.id, (error) => finish({ kind: 'spawn-error', error }));
    relay.onExit(spawned.id, () => finish({ kind: 'exit' }));
    const attempt = () => {
      if (settled) return;
      let hello;
      try {
        hello = Promise.resolve(targetHello({
          host: '127.0.0.1',
          port: localPort,
          frame: TARGET_HELLO,
          timeoutMs: Math.max(1, deadline - Date.now()),
          signal: controller.signal,
        }));
      } catch (error) {
        finish({ kind: 'hello-error', error });
        return;
      }
      hello.then(
        (result) => {
          if (settled) return;
          if (result?.ok === true) {
            finish({ kind: 'ready' });
            return;
          }
          const refused = result?.code === 'ECONNREFUSED';
          const budgetLeft = deadline - Date.now();
          if (refused && !childHasExited(spawned.child) && !controller.signal.aborted && budgetLeft > HELLO_RETRY_DELAY_MS) {
            setTimeout(attempt, HELLO_RETRY_DELAY_MS);
            return;
          }
          finish({ kind: 'hello', hello: result });
        },
        (error) => finish({ kind: 'hello-error', error }),
      );
    };
    attempt();
  });
}

function defaultTargetHello({ host, port, frame, timeoutMs, signal }) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let buffer = Buffer.alloc(0);
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
    const onAbort = () => finish({ ok: false, error: 'aborted' });
    signal?.addEventListener?.('abort', onAbort, { once: true });
    // The hello is a JSON message on the wire: the target decodes the relay frame, then JSON.parses
    // this payload. Serialising here (not in encodeRelayFrame) keeps the framer a pure byte layer.
    socket.on('connect', () => socket.write(encodeRelayFrame(JSON.stringify(frame))));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let decoded;
      try {
        decoded = decodeRelayFrames(buffer);
      } catch {
        return;
      }
      buffer = decoded.remaining;
      for (const payload of decoded.frames) {
        let message;
        try {
          message = JSON.parse(payload.toString('utf8'));
        } catch {
          continue;
        }
        if (message?.kind === TARGET_HELLO_OK.kind) {
          finish({ ok: true });
          return;
        }
      }
    });
    // The Node error code travels with the result so a dial can tell "nothing is listening yet"
    // (retryable) from "the target answered nothing" (terminal) without string-matching a message.
    socket.on('error', (error) => finish({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof Error && typeof error.code === 'string' ? error.code : undefined,
    }));
  });
}

async function safeTerminate(relay, id) {
  try {
    await relay.terminate(id);
  } catch {
    // A teardown failure must not mask the readiness/authorization result.
  }
}

/**
 * Creates the SSH transport. `open(profile)` resolves the alias through ssh_config, verifies the
 * presented host key against known_hosts (rejecting a changed key before any spawn), runs the
 * challenge-based authentication, allocates a loopback port, spawns ssh with a secret-free argv,
 * and only reports `ready` after the target hello succeeds. `close()` retires every active and
 * dialing connection so no owned process or secret temp file is left behind.
 */
export function createSshTransport(options = {}) {
  const platform = options.platform ?? process.platform;
  const states = new Map();
  const connections = new Map();
  let closed = false;

  async function closeConnection(record) {
    record.released = true;
    const relay = record.relay;
    const spawned = record.spawned;
    record.spawned = undefined;
    if (relay !== undefined && spawned !== undefined) {
      try {
        await relay.terminate(spawned.id);
      } catch {
        // A teardown failure must not mask the dial result; the record is still retired.
      }
    }
    const channel = record.secretChannel;
    record.secretChannel = undefined;
    if (channel !== undefined) {
      try {
        await channel.cleanup();
      } catch {
        // The record is retired even if the secret file could not be removed.
      }
    }
    if (connections.get(record.profileId) === record) connections.delete(record.profileId);
  }

  async function open(profile) {
    requireValue(profile?.transport?.kind === 'ssh', 'transport.kind', 'unsupported');
    const profileId = profile.profileId;
    const parsed = parseEndpoint(profile.transport.endpoint);
    states.set(profileId, 'authenticating');

    const previous = connections.get(profileId);
    if (previous !== undefined) await closeConnection(previous);
    const record = { profileId, relay: undefined, spawned: undefined, secretChannel: undefined, released: false };
    connections.set(profileId, record);

    let auth;
    let target;
    try {
      const configText = options.configText ?? await loadOptionalFile(options.configPath);
      target = resolveSshTarget({ host: parsed.host, port: parsed.port, configText });
      const knownHostsText = options.knownHostsText ?? await loadOptionalFile(options.knownHostsPath ?? defaultKnownHostsPath());
      const presented = await (options.hostKeyProvider ?? defaultHostKeyProvider)(target);
      const session = createAuthenticationSession({
        host: target.host,
        port: target.port,
        user: target.user,
        hostKey: presented,
        knownHosts: parseKnownHosts(knownHostsText),
        method: options.method ?? methodForCredential(profile.credentialRef),
        responder: options.responder,
        passphraseRequired: options.passphraseRequired,
      });
      auth = await session.authenticate();
      if (auth.knownHostEntry !== undefined && typeof options.persistKnownHost === 'function') {
        await options.persistKnownHost(auth.knownHostEntry);
      }
    } catch (error) {
      if (connections.get(profileId) === record) connections.delete(profileId);
      throw error;
    }

    const relay = options.relay ?? createProcessRelay({
      spawn: options.spawn,
      stopProcessTree: options.stopProcessTree,
      platform,
    });
    record.relay = relay;
    const secretChannel = await createSecretChannel(auth.secrets, {
      directory: options.secretDirectory,
      askpassPath: options.askpassPath,
      display: options.display,
    });
    record.secretChannel = secretChannel;

    if (record.released || closed) {
      await closeConnection(record);
      throw new ProtocolError('cancelled', 'transport.closed');
    }

    const fail = async (error) => {
      await closeConnection(record);
      states.set(profileId, 'failed');
      throw error;
    };

    const environment = buildSshEnvironment({ base: options.baseEnv, channel: secretChannel });
    const targetHello = options.targetHello ?? defaultTargetHello;
    const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    const remoteHost = options.remoteHost ?? '127.0.0.1';
    const remotePort = options.remotePort ?? 23_004;
    let localPort;
    let lastError = new ProtocolError('source_unavailable', 'forward.port');

    for (let attempt = 1; attempt <= MAX_FORWARD_ATTEMPTS; attempt += 1) {
      let port;
      try {
        port = await (options.readAllocatedPort ?? defaultAllocateLocalPort)();
      } catch (error) {
        return fail(error);
      }
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        return fail(new ProtocolError('source_unavailable', 'forward.port'));
      }
      localPort = port;

      let argv;
      try {
        argv = buildSshArgv({
          target,
          platform,
          forward: { localHost: '127.0.0.1', localPort, remoteHost, remotePort },
          configPath: options.configPath,
          knownHostsFile: options.knownHostsFile ?? target.userKnownHostsFile,
          identityFiles: target.identityFiles,
        });
      } catch (error) {
        return fail(error);
      }

      let spawned;
      try {
        spawned = relay.spawnOwned({ command: sshProgram(platform), args: argv, env: environment, cwd: options.cwd });
      } catch (error) {
        return fail(error);
      }
      record.spawned = spawned;
      if (record.released || closed) {
        await closeConnection(record);
        throw new ProtocolError('cancelled', 'transport.closed');
      }
      states.set(profileId, 'awaiting-hello');

      const outcome = await awaitForward({ relay, spawned, targetHello, helloTimeoutMs, localPort });
      if (outcome.kind === 'ready') {
        if (record.released || closed) {
          await closeConnection(record);
          throw new ProtocolError('cancelled', 'transport.closed');
        }
        states.set(profileId, 'ready');
        return Object.freeze({
          environmentId: resolveProfileEnvironment(profile),
          connectionId: `ssh-${profileId}`,
          state: 'ready',
          ready: true,
          forward: Object.freeze({ host: '127.0.0.1', port: localPort }),
          async close() {
            states.set(profileId, 'closed');
            await closeConnection(record);
          },
        });
      }
      if (outcome.kind === 'spawn-error') return fail(outcome.error);
      if (outcome.kind === 'hello-error') return fail(new ProtocolError('timeout', 'target.hello'));
      if (outcome.kind === 'hello' && !childHasExited(spawned.child)) {
        return fail(new ProtocolError('timeout', 'target.hello'));
      }
      await safeTerminate(relay, spawned.id);
      record.spawned = undefined;
    }
    return fail(lastError);
  }

  return Object.freeze({
    open,
    state(profileId) {
      return states.get(profileId) ?? 'disconnected';
    },
    async close() {
      closed = true;
      const records = [...connections.values()];
      connections.clear();
      await Promise.all(records.map((record) => closeConnection(record)));
      states.clear();
    },
  });
}
