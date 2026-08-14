#!/usr/bin/env node
/**
 * Real-runtime Electron smoke driver (Scenario S2).
 *
 * Launches the unpacked PACKAGED Vis executable (path via VIS_ELECTRON_EXECUTABLE)
 * with the Chromium sandbox EXPLICITLY enabled (`chromiumSandbox: true`) and an
 * isolated temp `--user-data-dir` profile, then asserts the packaged surface:
 *
 *   - argv carries no sandbox-disable switch and commandLine has no
 *     'no-sandbox' switch; webPreferences.sandbox === true
 *   - app.isPackaged === true; app.getPath('userData') === the temp profile
 *   - exactly one window, visible, on app://index.html
 *   - preload API schema matches the Task 2 contract
 *     (electronPreloadContract.test.ts) — no invented list
 *   - persistentStorage set/get round-trip, relaunch persistence, remove
 *   - clipboard write (via preload) -> read (in main) round-trip
 *   - window.open() creates no child window
 *   - no uncaught console errors (page + main process)
 *
 * Writes receipt.json + screenshot.png + console.log into the output dir
 * (VIS_SMOKE_OUT_DIR, default /tmp/vis-electron-smoke/<ts>). ALWAYS closes the
 * app and deletes the temp profile, even on assertion failure. If the Linux
 * lane cannot enable the sandbox the receipt is marked `blocked: true` and the
 * driver exits non-zero — the sandbox requirement is never relaxed.
 *
 * Usage:
 *   pnpm electron:preview
 *   VIS_ELECTRON_EXECUTABLE=dist-electron/linux-unpacked/vis pnpm qa:electron
 */
import { _electron } from 'playwright';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EXPECTED_PRELOAD_SCHEMA,
  SANDBOX_DISABLE_SWITCH,
  UNCAUGHT_RE,
  closeApp,
  collectPreloadSchema,
  getMainState,
  getWindowState,
  probeUsernsClone,
  sleep,
} from './electron-smoke-utils.mjs';

const WATCHDOG_MS = 240000;
const LAUNCH_TIMEOUT_MS = 90000;
const STORAGE_KEY = 'vis.smoke.key.v1';
const STORAGE_VALUE = 'smoke-value-1';
const CLIPBOARD_TEXT = `vis-smoke-clipboard-${Date.now()}`;

const OUT_DIR = path.resolve(
  process.env.VIS_SMOKE_OUT_DIR ??
    path.join(tmpdir(), 'vis-electron-smoke', new Date().toISOString().replace(/[:.]/g, '-')),
);
const RECEIPT_PATH = path.join(OUT_DIR, 'receipt.json');
const SCREENSHOT_PATH = path.join(OUT_DIR, 'screenshot.png');
const CONSOLE_LOG_PATH = path.join(OUT_DIR, 'console.log');

async function main() {
  const executablePath = process.env.VIS_ELECTRON_EXECUTABLE;
  if (!executablePath) {
    throw new Error(
      'VIS_ELECTRON_EXECUTABLE is required: point it at the unpacked packaged executable (pnpm electron:preview first)',
    );
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const profileDir = mkdtempSync(path.join(tmpdir(), 'vis-electron-smoke-profile-'));
  const launchArgs = [`--user-data-dir=${profileDir}`];
  // NOTE: every `_electron.launch` call site inlines `chromiumSandbox: true`
  // and the isolated `--user-data-dir` arg on purpose — the contract test
  // pins each launch block, so a future edit cannot silently relax the
  // sandbox by editing a shared options object elsewhere.

  const consoleLines = [];
  const pageErrors = [];
  const mainErrors = [];
  const assertions = [];
  const usernsClone = await probeUsernsClone();
  const receipt = {
    schema: 'vis-electron-smoke-receipt',
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    executablePath,
    launch: { chromiumSandbox: true, userDataDir: profileDir, argv: launchArgs },
    sandbox: { chromiumSandboxOption: true, kernel: { platform: process.platform, unshareUsernsClone: usernsClone } },
    pass: false,
    blocked: false,
    artifacts: { receipt: 'receipt.json', screenshot: 'screenshot.png', consoleLog: 'console.log' },
  };

  let appRef = { current: null };
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    try {
      appRef.current?.process()?.kill('SIGKILL');
    } catch {
      // process already gone
    }
  }, WATCHDOG_MS);

  const record = (name, pass, detail) => {
    assertions.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const observedPages = new WeakSet();
  const attachPageListeners = (page) => {
    if (observedPages.has(page)) return;
    observedPages.add(page);
    page.on('console', (msg) => {
      const text = msg.text();
      consoleLines.push(`[page:console:${msg.type()}] ${text}`);
      if (msg.type() === 'error' && UNCAUGHT_RE.test(text)) pageErrors.push(text);
    });
    page.on('pageerror', (error) => pageErrors.push(String(error)));
  };

  const attachAppListeners = (electronApp) => {
    electronApp.on('console', (msg) => {
      const text = msg.text();
      consoleLines.push(`[main:console:${msg.type()}] ${text}`);
      if (msg.type() === 'error' && UNCAUGHT_RE.test(text)) mainErrors.push(text);
    });
    electronApp.process().stdout?.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) if (line) consoleLines.push(`[main:stdout] ${line}`);
    });
    electronApp.process().stderr?.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (!line) continue;
        consoleLines.push(`[main:stderr] ${line}`);
        if (UNCAUGHT_RE.test(line)) mainErrors.push(line);
      }
    });
    electronApp.on('window', attachPageListeners);
    for (const page of electronApp.windows()) attachPageListeners(page);
  };

  async function launchAndProbe() {
    const electronApp = await _electron.launch({
      executablePath,
      args: [`--user-data-dir=${profileDir}`],
      chromiumSandbox: true,
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
      timeout: LAUNCH_TIMEOUT_MS,
    });
    appRef.current = electronApp;
    attachAppListeners(electronApp);
    const page = await electronApp.firstWindow();
    attachPageListeners(page);
    await page.waitForLoadState('load');
    return { app: electronApp, page };
  }

  try {
    let { app, page } = await launchAndProbe();

    const mainState = await app.evaluate(getMainState);
    record(
      'launch-argv-has-no-sandbox-disable-switch',
      mainState.argv.every((arg) => !arg.startsWith(SANDBOX_DISABLE_SWITCH)) && !mainState.noSandboxSwitch,
      `argv ${JSON.stringify(mainState.argv)}`,
    );
    const profileMatches = realpathSync(mainState.userData) === realpathSync(profileDir);
    record(
      'user-data-dir-isolated-profile',
      profileMatches,
      `expected ${profileDir}, actual ${mainState.userData}`,
    );
    receipt.userData = { expected: profileDir, actual: mainState.userData, match: profileMatches };
    if (!profileMatches) {
      // The lane cannot honor an isolated profile — report blocked, never relax.
      receipt.blocked = true;
    }
    record('app-is-packaged', mainState.isPackaged === true, String(mainState.isPackaged));

    const versions = await page.evaluate(() => window.electronAPI.versions);
    const platformInfo = await app.evaluate(() => ({ platform: process.platform, arch: process.arch }));
    receipt.electronVersion = versions.electron;
    receipt.platform = platformInfo;
    receipt.runtimeVersions = versions;
    record('platform-and-versions-captured', true, `${platformInfo.platform}/${platformInfo.arch} electron ${versions.electron} chrome ${versions.chrome} node ${versions.node}`);

    // Wait for the main window to become visible (ready-to-show), then check sandbox + URL.
    let windowState = null;
    for (let attempt = 0; attempt < 80 && !timedOut; attempt += 1) {
      windowState = await app.evaluate(getWindowState);
      if (windowState && windowState.visible) break;
      await sleep(250);
    }
    const sandboxEnabled =
      windowState !== null &&
      windowState.sandbox === true &&
      mainState.argv.every((arg) => !arg.startsWith(SANDBOX_DISABLE_SWITCH)) &&
      !mainState.noSandboxSwitch;
    if (!sandboxEnabled) receipt.blocked = true;
    record('sandbox-enabled', sandboxEnabled, windowState ? `webPreferences.sandbox=${windowState.sandbox}` : 'no window state');
    receipt.sandbox = {
      ...receipt.sandbox,
      status: sandboxEnabled ? 'enabled' : 'blocked',
      webPreferencesSandbox: windowState?.sandbox ?? null,
      commandLineNoSandboxSwitch: !mainState.noSandboxSwitch,
    };

    record('single-window', windowState?.count === 1, `count=${windowState?.count}`);
    record('window-visible', windowState?.visible === true, String(windowState?.visible));
    // Chromium serializes the app entry as `app://index.html/` (standard scheme
    // with an empty path); both forms resolve to index.html — see runtimePolicy.
    const finalUrl = page.url();
    const urlOk = finalUrl === 'app://index.html' || finalUrl === 'app://index.html/';
    record('final-url-app-index', urlOk, finalUrl);
    receipt.window = { count: windowState?.count ?? 0, url: finalUrl, visible: windowState?.visible ?? false };

    const schema = await page.evaluate(collectPreloadSchema);
    const schemaMatch = Object.keys(EXPECTED_PRELOAD_SCHEMA).every(
      (group) => JSON.stringify(schema[group]) === JSON.stringify(EXPECTED_PRELOAD_SCHEMA[group]),
    );
    record('preload-schema-matches-task2-contract', schemaMatch, JSON.stringify(schema));
    receipt.preloadSchema = { match: schemaMatch, actual: schema };

    // persistentStorage round-trip (same session).
    const storageRoundTrip = await page.evaluate(
      ([key, value]) => {
        window.electronAPI.persistentStorage.setItem(key, value);
        return window.electronAPI.persistentStorage.getItem(key);
      },
      [STORAGE_KEY, STORAGE_VALUE],
    );
    record('persistent-storage-set-get', storageRoundTrip === STORAGE_VALUE, `got ${JSON.stringify(storageRoundTrip)}`);

    // clipboard write via preload -> read back in main.
    await page.evaluate((text) => window.electronAPI.clipboard.writeText(text), CLIPBOARD_TEXT);
    const readBack = await app.evaluate(({ clipboard }) => clipboard.readText());
    record('clipboard-write-read-roundtrip', readBack === CLIPBOARD_TEXT, `read ${JSON.stringify(readBack)}`);
    receipt.clipboard = { written: CLIPBOARD_TEXT, readBack };

    // window.open must not create a child window (setWindowOpenHandler denies).
    const beforeOpen = await app.evaluate(getWindowState);
    await page.evaluate(() => window.open('https://example.com'));
    await sleep(750);
    const afterOpen = await app.evaluate(getWindowState);
    const noChildWindow = afterOpen.count === 1 && beforeOpen.count === 1;
    record('window-open-creates-no-child-window', noChildWindow, `windows before=${beforeOpen.count} after=${afterOpen.count}`);

    await page.screenshot({ path: SCREENSHOT_PATH });
    consoleLines.push(`[driver] screenshot saved to ${SCREENSHOT_PATH}`);

    // Relaunch against the SAME profile: the stored value must survive.
    await closeApp(app);
    appRef.current = null;
    ({ app, page } = await launchAndProbe());
    const persisted = await page.evaluate((key) => window.electronAPI.persistentStorage.getItem(key), STORAGE_KEY);
    record('persistent-storage-survives-relaunch', persisted === STORAGE_VALUE, `got ${JSON.stringify(persisted)}`);
    const removed = await page.evaluate((key) => {
      window.electronAPI.persistentStorage.removeItem(key);
      return window.electronAPI.persistentStorage.getItem(key);
    }, STORAGE_KEY);
    record('persistent-storage-remove', removed === null, `got ${JSON.stringify(removed)}`);
    receipt.persistentStorage = { key: STORAGE_KEY, roundTrip: storageRoundTrip === STORAGE_VALUE, survivedRelaunch: persisted === STORAGE_VALUE, removed: removed === null };

    // Console cleanliness (uncaught only; handled diagnostics recorded in the log).
    record('no-uncaught-console-errors', pageErrors.length === 0 && mainErrors.length === 0,
      `pageErrors=${pageErrors.length} mainErrors=${mainErrors.length}`);
    receipt.console = { pageErrors, mainErrors };

    if (timedOut) {
      record('watchdog-timeout', false, 'driver exceeded overall time budget and force-killed the app');
    }

    receipt.assertions = assertions;
    receipt.pass = assertions.length > 0 && assertions.every((a) => a.pass) && !receipt.blocked;
    console.log(`\nSMOKE ${receipt.pass ? 'PASS' : 'FAIL'}${receipt.blocked ? ' (BLOCKED: sandbox could not be enabled)' : ''}`);
    console.log(`receipt: ${RECEIPT_PATH}`);
  } catch (error) {
    // A launch that dies before ready because the sandbox cannot initialize is
    // reported as BLOCKED with the kernel evidence — the requirement is never
    // relaxed to a sandbox-disable flag.
    const failure = String(error?.stack ?? error);
    if (/sandbox|user namespace|userns/i.test(failure)) {
      receipt.blocked = true;
      console.error(`SANDBOX BLOCKED — ${failure}`);
    } else {
      console.error(`SMOKE FAIL — ${failure}`);
    }
    record('driver-execution', false, failure);
    receipt.assertions = assertions;
  } finally {
    clearTimeout(watchdog);
    await closeApp(appRef.current);
    appRef.current = null;
    rmSync(profileDir, { recursive: true, force: true });
    try {
      await import('node:fs').then(({ writeFileSync }) => writeFileSync(CONSOLE_LOG_PATH, consoleLines.join('\n') + '\n', 'utf8'));
    } catch {
      // console log is best-effort
    }
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(RECEIPT_PATH, JSON.stringify(receipt, null, 2), 'utf8');
    } catch {
      receipt.pass = false;
      // receipt write failure is reported through the exit code
    }
  }

  return receipt.pass && !receipt.blocked;
}

main()
  .then((pass) => {
    // Hard exit: all artifacts (receipt, screenshot, console log) and the temp
    // profile cleanup already happened in `finally`; stray child stdio pipes
    // must not keep the process alive.
    process.exit(pass ? 0 : 1);
  })
  .catch((error) => {
    console.error(`SMOKE FAIL — ${error.stack ?? error}`);
    process.exit(1);
  });
