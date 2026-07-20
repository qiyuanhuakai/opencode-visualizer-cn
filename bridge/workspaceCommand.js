import { spawn } from 'node:child_process';

const OUTPUT_LIMIT = 2 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export function runWorkspaceCommand(payload, options = {}) {
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
  const spawnProcess = options.spawnProcess ?? spawn;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const append = (current, chunk) => {
      const next = Buffer.concat([current, Buffer.from(chunk)]);
      if (next.length > OUTPUT_LIMIT) {
        child.kill('SIGKILL');
        finish(() => reject(new Error('Command output exceeded the 2 MiB limit.')));
      }
      return next;
    };
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (exitCode) => {
      finish(() =>
        resolve({
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          exitCode: typeof exitCode === 'number' ? exitCode : -1,
        }),
      );
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error('Command timed out after 30 seconds.')));
    }, TIMEOUT_MS);
    timer.unref?.();
  });
}
