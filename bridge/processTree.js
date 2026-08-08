import { spawn } from 'node:child_process';

export function detachedProcessOptions() {
  return process.platform === 'win32' ? {} : { detached: true };
}

export function signalProcessTree(child, signal) {
  if (process.platform === 'win32' && child.pid) {
    void stopWindowsProcessTree(child.pid, signal === 'SIGKILL');
    return true;
  }
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {}
  }
  return child.kill(signal);
}

export async function forceStopProcessTree(pid) {
  if (process.platform === 'win32') {
    await stopWindowsProcessTree(pid, true);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {}
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const finish = (exited) => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('close', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once('exit', onExit);
    child.once('close', onExit);
  });
}

export async function stopProcessTree(child, options = {}) {
  const graceMs = options.graceMs ?? 1_500;
  const forceMs = options.forceMs ?? 3_000;
  signalProcessTree(child, 'SIGTERM');
  if (await waitForProcessExit(child, graceMs)) return;
  if (child.pid) await forceStopProcessTree(child.pid);
  else signalProcessTree(child, 'SIGKILL');
  if (!(await waitForProcessExit(child, forceMs))) {
    throw new Error(`Process tree did not stop (pid ${child.pid ?? 'unknown'}).`);
  }
}

function stopWindowsProcessTree(pid, force) {
  return new Promise((resolve) => {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    const killer = spawn('taskkill', args, {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', resolve);
    killer.once('exit', resolve);
  });
}
