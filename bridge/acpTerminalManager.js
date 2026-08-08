import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { STOP_GRACE_MS } from './acpProcessState.js';
import { detachedProcessOptions, signalProcessTree } from './processTree.js';

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
    entry.output = Buffer.concat([entry.output, Buffer.from(chunk)]);
    if (entry.outputByteLimit !== null && entry.output.length > entry.outputByteLimit) {
      entry.output = entry.output.subarray(entry.output.length - entry.outputByteLimit);
      entry.truncated = true;
    }
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
      output: Buffer.alloc(0),
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
      output: entry.output.toString('utf8'),
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
    if (!entry.exitStatus) {
      const forceKill = setTimeout(() => {
        try {
          signalProcessTree(entry.child, 'SIGKILL');
        } catch {}
      }, STOP_GRACE_MS);
      try {
        signalProcessTree(entry.child, 'SIGTERM');
        await entry.exit;
      } finally {
        clearTimeout(forceKill);
      }
    }
    return {};
  }

  async function release(terminalId) {
    const entry = requireTerminal(terminalId);
    if (!entry.exitStatus) await kill(terminalId);
    terminals.delete(terminalId);
    return {};
  }

  async function stopAll() {
    await Promise.all([...terminals.keys()].map((terminalId) => release(terminalId)));
  }

  return { create, output, waitForExit, kill, release, stopAll };
}
