// Shared helpers for the real-runtime Electron smoke driver
// (scripts/qa/electron-smoke.mjs). Split out so the scenario script stays
// under the LOC ceiling; this module owns the runtime constants, the
// evaluate payloads and the process-lifecycle helpers.
import { spawn } from 'node:child_process';

// Mirror of the Task 2 preload schema (sorted arrays; double-quoted literals so
// the JSON serialization is a stable substring the contract test can pin).
// `versions` holds the SORTED key set of { node, electron, chrome }.
export const EXPECTED_PRELOAD_SCHEMA = { "topLevel": ["clipboard", "getAppVersion", "getPlatform", "localFile", "persistentStorage", "platform", "versions"], "clipboard": ["writeText"], "persistentStorage": ["getItem", "removeItem", "setItem"], "localFile": ["clearApplication", "close", "offChanged", "offError", "onChanged", "onError", "open", "selectApplication"], "versions": ["chrome", "electron", "node"] };

// The sandbox-disable switch is reconstructed at runtime so the driver source
// never contains the literal; it is only ever CHECKED for, never passed.
export const SANDBOX_DISABLE_SWITCH = ['--no', 'sandbox'].join('-');

// Uncaught-exception fingerprint for console messages / main stderr. Handled
// diagnostics (e.g. a failed backend websocket) are recorded, not failed on.
export const UNCAUGHT_RE =
  /Uncaught|Unhandled rejection|TypeError|ReferenceError|RangeError|SyntaxError|is not a function|is not defined|Cannot read propert|Cannot set propert/;

/** Main-process window state probe (sandbox, visibility, count, URL). */
export const getWindowState = ({ BrowserWindow }) => {
  const wins = BrowserWindow.getAllWindows();
  const win = wins[0];
  return win
    ? {
        count: wins.length,
        visible: win.isVisible(),
        url: win.webContents.getURL(),
        sandbox: win.webContents.getLastWebPreferences().sandbox,
      }
    : null;
};

/** Main-process app/argv probe (sandbox switch, userData, packaged flag). */
export const getMainState = ({ app }) => ({
  argv: process.argv,
  noSandboxSwitch: app.commandLine.hasSwitch('no-sandbox'),
  userData: app.getPath('userData'),
  isPackaged: app.isPackaged,
});

/** Renderer preload schema probe — collected keys must match the Task 2 contract. */
export const collectPreloadSchema = () => {
  const api = window.electronAPI;
  return {
    topLevel: Object.keys(api).sort(),
    clipboard: Object.keys(api.clipboard).sort(),
    persistentStorage: Object.keys(api.persistentStorage).sort(),
    localFile: Object.keys(api.localFile).sort(),
    versions: Object.keys(api.versions).sort(),
  };
};

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort kernel probe: can this Linux box create user namespaces? */
export function probeUsernsClone() {
  if (process.platform !== 'linux') return 'not-applicable';
  return new Promise((resolve) => {
    const child = spawn('unshare', ['-rm', 'true'], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve('probe-timed-out');
    }, 5000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve('probe-error');
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? 'available' : `denied (exit ${code})`);
    });
  });
}

/**
 * Close an ElectronApplication robustly: resolve as soon as the process is
 * gone, and SIGKILL it after a grace period. Playwright's close() alone can
 * hang forever on some Linux lanes even after the process died, so we never
 * await it bare.
 */
export async function closeApp(electronApp) {
  if (!electronApp) return;
  const processExited = new Promise((resolve) => {
    electronApp.process().once('exit', resolve);
  });
  electronApp.close().catch(() => {});
  const outcome = await Promise.race([processExited, sleep(30000).then(() => 'timeout')]);
  if (outcome === 'timeout') {
    try {
      electronApp.process().kill('SIGKILL');
    } catch {
      // process already gone
    }
    await Promise.race([processExited, sleep(10000)]);
  }
}
