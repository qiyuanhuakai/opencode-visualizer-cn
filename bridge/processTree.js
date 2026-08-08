import { spawn } from 'node:child_process';

export function detachedProcessOptions() {
  return process.platform === 'win32' ? {} : { detached: true };
}

export function signalProcessTree(child, signal) {
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
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', resolve);
      killer.once('exit', resolve);
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {}
}
