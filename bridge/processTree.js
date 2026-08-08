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
