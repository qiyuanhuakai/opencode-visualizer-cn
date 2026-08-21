import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { STOP_GRACE_MS } from './acpProcessState.js';
import { detachedProcessOptions, stopProcessTree } from './processTree.js';

function parseEnvironment(value) {
  if (value === undefined) return {};
  if (!Array.isArray(value)) throw new Error('ACP terminal env must be an array.');
  return Object.fromEntries(value.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.value !== 'string') {
      throw new Error('ACP terminal env entries require name and value.');
    }
    return [item.name, item.value];
  }));
}

export function createAcpTerminalManager(options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const terminals = new Map();

  function appendOutput(entry, chunk) {
    const buffer = Buffer.from(chunk);
    if (buffer.length === 0) return;
    if (entry.outputByteLimit === null) {
      entry.outputChunks.push(buffer);
      entry.outputByteLength += buffer.length;
      return;
    }
    if (buffer.length >= entry.outputByteLimit) {
      entry.outputChunks = entry.outputByteLimit === 0
        ? []
        : [buffer.subarray(buffer.length - entry.outputByteLimit)];
      entry.outputByteLength = entry.outputByteLimit;
      entry.truncated = true;
      return;
    }
    entry.outputChunks.push(buffer);
    entry.outputByteLength += buffer.length;
    while (entry.outputByteLength > entry.outputByteLimit) {
      const first = entry.outputChunks[0];
      const remove = Math.min(first.length, entry.outputByteLength - entry.outputByteLimit);
      if (remove === first.length) entry.outputChunks.shift();
      else entry.outputChunks[0] = first.subarray(remove);
      entry.outputByteLength -= remove;
      entry.truncated = true;
    }
  }

  function utf8SequenceWidth(byte) {
    if (byte <= 0x7f) return 1;
    if (byte >= 0xc2 && byte <= 0xdf) return 2;
    if (byte >= 0xe0 && byte <= 0xef) return 3;
    if (byte >= 0xf0 && byte <= 0xf4) return 4;
    return 0;
  }

  function hasCompleteUtf8Sequence(buffer, start, width) {
    if (start + width > buffer.length) return false;
    return buffer
      .subarray(start + 1, start + width)
      .every((byte) => (byte & 0xc0) === 0x80);
  }

  function utf8SafeTail(buffer) {
    for (let start = 0; start < buffer.length; start += 1) {
      const width = utf8SequenceWidth(buffer[start]);
      if (width > 0 && hasCompleteUtf8Sequence(buffer, start, width)) {
        return buffer.subarray(start);
      }
    }
    return Buffer.alloc(0);
  }

  async function create(params) {
    if (typeof params.command !== 'string' || !params.command) throw new Error('ACP terminal command is required.');
    const args = params.args === undefined ? [] : params.args;
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new Error('ACP terminal args must be strings.');
    }
    const outputByteLimit = params.outputByteLimit === undefined || params.outputByteLimit === null
      ? null
      : params.outputByteLimit;
    if (outputByteLimit !== null && (!Number.isInteger(outputByteLimit) || outputByteLimit < 0)) {
      throw new Error('ACP terminal outputByteLimit must be a non-negative integer.');
    }
    const child = spawnProcess(params.command, args, {
      cwd: params.cwd,
      env: { ...process.env, ...parseEnvironment(params.env) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...detachedProcessOptions(),
    });
    const terminalId = randomUUID();
    let resolveExit;
    const exit = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const entry = {
      child,
      outputChunks: [],
      outputByteLength: 0,
      outputByteLimit,
      truncated: false,
      exitStatus: null,
      exit,
    };
    terminals.set(terminalId, entry);
    child.stdout.on('data', (chunk) => appendOutput(entry, chunk));
    child.stderr.on('data', (chunk) => appendOutput(entry, chunk));
    const launched = await new Promise((resolve, reject) => {
      child.once('spawn', () => resolve(true));
      child.once('error', (error) => {
        terminals.delete(terminalId);
        reject(error);
      });
    });
    if (!launched) throw new Error('ACP terminal failed to start.');
    child.once('exit', (exitCode, signal) => {
      entry.exitStatus = { exitCode, signal };
    });
    child.once('close', (exitCode, signal) => {
      entry.exitStatus ??= { exitCode, signal };
      resolveExit(entry.exitStatus);
    });
    return { terminalId };
  }

  function requireTerminal(terminalId) {
    const entry = terminals.get(terminalId);
    if (!entry) throw new Error(`ACP terminal not found: ${terminalId}`);
    return entry;
  }

  function output(terminalId) {
    const entry = requireTerminal(terminalId);
    return {
      output: utf8SafeTail(Buffer.concat(entry.outputChunks)).toString('utf8'),
      truncated: entry.truncated,
      ...(entry.exitStatus ? { exitStatus: entry.exitStatus } : {}),
    };
  }

  async function waitForExit(terminalId) {
    const entry = requireTerminal(terminalId);
    return entry.exitStatus ?? entry.exit;
  }

  async function kill(terminalId) {
    const entry = requireTerminal(terminalId);
    await stopProcessTree(entry.child, { graceMs: STOP_GRACE_MS });
    return {};
  }

  async function release(terminalId) {
    requireTerminal(terminalId);
    await kill(terminalId);
    terminals.delete(terminalId);
    return {};
  }

  async function stopAll() {
    await Promise.all([...terminals.keys()].map((terminalId) => release(terminalId)));
  }

  return { create, output, waitForExit, kill, release, stopAll };
}
