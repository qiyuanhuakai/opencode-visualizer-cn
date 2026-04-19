import { spawn } from 'node:child_process';
import http from 'node:http';

const DEV_SERVER_HOST = '127.0.0.1';
const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://${DEV_SERVER_HOST}:${DEV_SERVER_PORT}`;
const DEV_SERVER_TIMEOUT_MS = 30_000;
const DEV_SERVER_POLL_INTERVAL_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function canConnect(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode !== undefined && response.statusCode < 500);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(1_500, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForDevServer() {
  const deadline = Date.now() + DEV_SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await canConnect(DEV_SERVER_URL)) {
      return true;
    }
    await sleep(DEV_SERVER_POLL_INTERVAL_MS);
  }
  return false;
}

function spawnChild(command, args, options = {}) {
  if (process.platform === 'win32') {
    const shell = process.env.ComSpec || 'cmd.exe';
    const commandLine = [command, ...args].map(quoteWindowsCommandArg).join(' ');

    return spawn(shell, ['/d', '/s', '/c', commandLine], {
      stdio: 'inherit',
      shell: false,
      ...options,
    });
  }

  return spawn(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options,
  });
}

function pnpmCommand() {
  return 'pnpm';
}

function quoteWindowsCommandArg(arg) {
  if (!/[\s"&|<>^()]/.test(arg)) {
    return arg;
  }

  return `"${arg.replace(/"/g, '""')}"`;
}

async function main() {
  let devServerProcess = null;

  if (!(await canConnect(DEV_SERVER_URL))) {
    console.log(`[electron:start] Vite dev server not detected at ${DEV_SERVER_URL}, starting pnpm dev...`);
    devServerProcess = spawnChild(pnpmCommand(), ['dev']);

    const ready = await waitForDevServer();
    if (!ready) {
      devServerProcess.kill('SIGTERM');
      throw new Error(`Timed out waiting for Vite dev server at ${DEV_SERVER_URL}`);
    }
  } else {
    console.log(`[electron:start] Reusing existing Vite dev server at ${DEV_SERVER_URL}`);
  }

  console.log('[electron:start] Launching Electron window...');
  const electronProcess = spawnChild(pnpmCommand(), ['exec', 'electron', '.']);

  const shutdown = (signal) => {
    if (electronProcess.exitCode === null) {
      electronProcess.kill(signal);
    }
    if (devServerProcess && devServerProcess.exitCode === null) {
      devServerProcess.kill(signal);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const exitCode = await new Promise((resolve, reject) => {
    electronProcess.on('exit', (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 0);
    });
    electronProcess.on('error', reject);
  });

  if (devServerProcess && devServerProcess.exitCode === null) {
    devServerProcess.kill('SIGTERM');
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error(`[electron:start] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
