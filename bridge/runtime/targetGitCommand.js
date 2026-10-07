import path from 'node:path';
import { realpath, stat, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import {
  parseEnvironmentId,
  parseWorkspaceRef,
  encodeWorkspaceKey,
} from '../../shared/runtime/identity.js';
import { requireValue, ProtocolError } from '../../shared/runtime/capabilities.js';
import { detachedProcessOptions, stopProcessTree } from '../processTree.js';

export class GitCommandError extends Error {
  constructor(reason, result = {}) {
    super(`source_unavailable: git.${reason}`);
    this.code = 'source_unavailable';
    this.reason = reason;
    this.result = result;
  }
}

// Construct on the execution target with host-owned grants and executable configuration.
export async function createTargetGitCommand({
  target,
  roots,
  assertCurrent,
  gitBinary = 'git',
  maxBytes = 2097152,
  resolvePathPolicy,
}) {
  const environmentId = parseEnvironmentId(target);
  requireValue(
    Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 8388608,
    'git.output_limit',
  );
  const grants = await Promise.all(
    roots.map(async (grant) => ({
      root: await realpath(grant.root),
      pathPolicy: { ...grant.pathPolicy },
      permissions: [...grant.permissions],
    })),
  );
  const jobs = new Set();
  let closed = false;
  function current() {
    requireValue(!closed, 'git.closed', 'source_unavailable');
    assertCurrent();
  }
  async function policyFor(canonicalPath) {
    current();
    if (resolvePathPolicy) return { ...(await resolvePathPolicy(canonicalPath)) };
    const grant = grants.find((item) => {
      const relative = path.relative(item.root, canonicalPath);
      return (
        relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      );
    });
    requireValue(grant, 'git.path_policy_unavailable', 'source_unavailable');
    return { ...grant.pathPolicy };
  }
  async function authorize(input, permission = 'command') {
    const workspace = parseWorkspaceRef(input);
    current();
    requireValue(workspace.environmentId === environmentId, 'git.target', 'unauthorized');
    const grant = grants.find((item) => {
      const relative = path.relative(item.root, workspace.canonicalPath);
      return (
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative) &&
        ['platform', 'volumeId', 'caseSensitive'].every(
          (key) => item.pathPolicy[key] === workspace.pathPolicy[key],
        ) &&
        item.permissions.includes(permission)
      );
    });
    requireValue(grant?.permissions.includes(permission), 'git.permission', 'unauthorized');
    try {
      const resolved = await realpath(workspace.canonicalPath);
      requireValue(
        resolved === workspace.canonicalPath && (await stat(resolved)).isDirectory(),
        'git.canonical_path',
      );
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new GitCommandError(error?.code === 'ENOENT' ? 'orphan' : 'path');
    }
    current();
    return workspace;
  }
  async function destination(parent, name) {
    requireValue(
      typeof name === 'string' &&
        name.length > 0 &&
        name.length <= 255 &&
        !/[/\\\0]/.test(name) &&
        name !== '.' &&
        name !== '..',
      'git.destination',
    );
    const workspace = await authorize(parent, 'write');
    const canonicalPath = path.join(workspace.canonicalPath, name);
    try {
      await lstat(canonicalPath);
      throw new ProtocolError('conflict', 'git.destination_exists');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return { ...workspace, canonicalPath };
  }
  async function start({ workspace, args, mutation = false }) {
    requireValue(
      Array.isArray(args) &&
        args.length > 0 &&
        args.length <= 128 &&
        args.every(
          (arg) =>
            typeof arg === 'string' && !arg.includes('\0') && Buffer.byteLength(arg) <= 32768,
        ),
      'git.argv',
    );
    const ref = await authorize(workspace);
    if (mutation) await authorize(ref, 'write');
    current();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    );
    requireValue(jobs.size < 16, 'git.capacity', 'conflict');
    const child = spawn(gitBinary, args, {
      cwd: ref.canonicalPath,
      env: { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...detachedProcessOptions(),
    });
    const buffers = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let failure;
    let stopping;
    const stop = () => (stopping ??= stopProcessTree(child));
    const done = new Promise((resolve) => {
      child.once('error', (error) => {
        failure = new GitCommandError(error.code === 'ENOENT' ? 'missing' : 'spawn');
      });
      for (const stream of ['stdout', 'stderr'])
        child[stream].on('data', (chunk) => {
          if (failure) return;
          sizes[stream] += chunk.length;
          if (sizes[stream] > maxBytes) {
            failure = new GitCommandError(`${stream}_overflow`);
            void stop().catch((error) => {
              failure = error;
            });
          } else buffers[stream].push(chunk);
        });
      child.once('close', (exitCode, signal) => {
        jobs.delete(job);
        resolve({
          stdout: Buffer.concat(buffers.stdout).toString('utf8'),
          stderr: Buffer.concat(buffers.stderr).toString('utf8'),
          exitCode,
          signal,
          failure,
        });
      });
    });
    const job = {
      pid: child.pid,
      workspaceKey: encodeWorkspaceKey(ref),
      async wait() {
        const { failure: error, ...result } = await done;
        if (error) throw error;
        return result;
      },
      async cancel() {
        await stop();
        await done;
      },
    };
    jobs.add(job);
    return job;
  }
  return {
    authorize,
    policyFor,
    destination,
    start,
    async run(request) {
      return (await start(request)).wait();
    },
    async close() {
      closed = true;
      await Promise.all([...jobs].map((job) => job.cancel()));
    },
  };
}
