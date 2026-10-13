import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
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
 * turns off agent forwarding, and `-L 127.0.0.1:0:…` requests a dynamic loopback port.
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
    argv.push('-L', `${forward.localHost ?? '127.0.0.1'}:${forward.localPort ?? 0}:${forward.remoteHost}:${forward.remotePort}`);
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

function defaultReadAllocatedPort(child, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new ProtocolError('timeout', 'forward.port')), timeoutMs);
    const finish = (port) => {
      clearTimeout(timer);
      child.stderr?.off?.('data', onData);
      child.off?.('close', onClose);
      resolve(port);
    };
    const onData = (chunk) => {
      buffer += String(chunk);
      const port = parseAllocatedPort(buffer);
      if (port !== undefined) finish(port);
    };
    const onClose = () => {
      clearTimeout(timer);
      reject(new ProtocolError('source_unavailable', 'forward.port'));
    };
    if (typeof child.stderr?.on !== 'function') {
      clearTimeout(timer);
      reject(new ProtocolError('source_unavailable', 'forward.port'));
      return;
    }
    child.stderr.on('data', onData);
    child.once?.('close', onClose);
  });
}

function defaultTargetHello({ host, port, frame, timeoutMs }) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
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
          clearTimeout(timer);
          socket.end();
          resolve({ ok: true });
          return;
        }
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
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
 * challenge-based authentication, spawns ssh with a secret-free argv, waits for the dynamic
 * loopback port, and only reports `ready` after the target hello succeeds.
 */
export function createSshTransport(options = {}) {
  const platform = options.platform ?? process.platform;
  const states = new Map();

  async function open(profile) {
    requireValue(profile?.transport?.kind === 'ssh', 'transport.kind', 'unsupported');
    const profileId = profile.profileId;
    const parsed = parseEndpoint(profile.transport.endpoint);
    states.set(profileId, 'authenticating');

    const configText = options.configText ?? await loadOptionalFile(options.configPath);
    const target = resolveSshTarget({ host: parsed.host, port: parsed.port, configText });
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
    const auth = await session.authenticate();
    if (auth.knownHostEntry !== undefined && typeof options.persistKnownHost === 'function') {
      await options.persistKnownHost(auth.knownHostEntry);
    }

    const argv = buildSshArgv({
      target,
      platform,
      forward: {
        localHost: '127.0.0.1',
        localPort: 0,
        remoteHost: options.remoteHost ?? '127.0.0.1',
        remotePort: options.remotePort ?? 23_004,
      },
      configPath: options.configPath,
      knownHostsFile: options.knownHostsFile ?? target.userKnownHostsFile,
      identityFiles: target.identityFiles,
    });

    const secretChannel = await createSecretChannel(auth.secrets, {
      directory: options.secretDirectory,
      askpassPath: options.askpassPath,
      display: options.display,
    });
    const relay = options.relay ?? createProcessRelay({
      spawn: options.spawn,
      stopProcessTree: options.stopProcessTree,
      platform,
    });
    const spawned = relay.spawnOwned({
      command: sshProgram(platform),
      args: argv,
      env: buildSshEnvironment({ base: options.baseEnv, channel: secretChannel }),
      cwd: options.cwd,
    });
    states.set(profileId, 'forwarding');

    const fail = async (error) => {
      await safeTerminate(relay, spawned.id);
      await secretChannel.cleanup();
      states.set(profileId, 'failed');
      throw error;
    };

    let localPort;
    try {
      localPort = await (options.readAllocatedPort ?? defaultReadAllocatedPort)(spawned.child);
    } catch (error) {
      return fail(error);
    }

    states.set(profileId, 'awaiting-hello');
    let hello;
    try {
      hello = await (options.targetHello ?? defaultTargetHello)({
        host: '127.0.0.1',
        port: localPort,
        frame: TARGET_HELLO,
        timeoutMs: options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS,
      });
    } catch {
      return fail(new ProtocolError('timeout', 'target.hello'));
    }
    if (hello?.ok !== true) {
      return fail(new ProtocolError('timeout', 'target.hello'));
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
        await safeTerminate(relay, spawned.id);
        await secretChannel.cleanup();
      },
    });
  }

  return Object.freeze({
    open,
    state(profileId) {
      return states.get(profileId) ?? 'disconnected';
    },
    async close() {
      states.clear();
    },
  });
}
