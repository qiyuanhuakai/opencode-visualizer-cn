import { spawn } from 'node:child_process';
import { appendBoundedBuffer } from './boundedOutput.js';
import { detachedProcessOptions, stopProcessTree } from './processTree.js';

const OUTPUT_LIMIT = 2 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export function createWorkspaceCommandRunner(options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const stopChild = options.stopProcessTree ?? stopProcessTree;
  const outputLimit = options.outputLimit ?? OUTPUT_LIMIT;
  const activeChildren = new Set();
  let accepting = true;
  let closePromise;

  function run(payload) {
    if (!accepting) return Promise.reject(new Error('Command runner is shutting down.'));
    if (!payload || typeof payload !== 'object') {
      return Promise.reject(new Error('Command payload must be an object.'));
    }
    const command = typeof payload.command === 'string' ? payload.command.trim() : '';
    if (!command) return Promise.reject(new Error('Command is required.'));
    const args = Array.isArray(payload.args) ? payload.args.map(String) : [];
    const cwd =
      typeof payload.directory === 'string' && payload.directory.trim()
        ? payload.directory.trim()
        : undefined;
    return new Promise((resolve, reject) => {
      const child = spawnProcess(command, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...detachedProcessOptions(),
      });
      activeChildren.add(child);
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;
      let stopping = false;
      let timer;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const failAndStop = (error) => {
        if (stopping) return;
        stopping = true;
        const complete = () => {
          activeChildren.delete(child);
          finish(() => reject(error));
        };
        void stopChild(child).then(complete, () => finish(() => reject(error)));
      };
      const append = (current, chunk) => {
        if (stopping) return current;
        const result = appendBoundedBuffer(current, chunk, outputLimit);
        if (result.overflow) {
          failAndStop(new Error('Command output exceeded the 2 MiB limit.'));
        }
        return result.buffer;
      };
      child.stdout.on('data', (chunk) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr = append(stderr, chunk);
      });
      child.once('error', (error) => {
        stopping = true;
        activeChildren.delete(child);
        finish(() => reject(error));
      });
      child.once('close', (exitCode) => {
        if (stopping) return;
        stopping = true;
        void stopChild(child).then(
          () => {
            activeChildren.delete(child);
            finish(() =>
              resolve({
                stdout: stdout.toString('utf8'),
                stderr: stderr.toString('utf8'),
                exitCode: typeof exitCode === 'number' ? exitCode : -1,
              }),
            );
          },
          (error) => {
            finish(() => reject(error));
          },
        );
      });
      timer = setTimeout(
        () => failAndStop(new Error('Command timed out after 30 seconds.')),
        TIMEOUT_MS,
      );
      timer.unref?.();
    });
  }

  async function stopAll() {
    const children = [...activeChildren];
    const results = await Promise.allSettled(children.map((child) => stopChild(child)));
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') activeChildren.delete(children[index]);
    }
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  function close() {
    accepting = false;
    closePromise ??= stopAll().catch((error) => {
      closePromise = undefined;
      throw error;
    });
    return closePromise;
  }

  return { run, close };
}
