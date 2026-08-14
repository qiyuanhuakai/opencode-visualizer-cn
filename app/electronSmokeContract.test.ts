import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DRIVER_PATH = path.resolve(__dirname, '../scripts/qa/electron-smoke.mjs');
const DRIVER_UTILS_PATH = path.resolve(__dirname, '../scripts/qa/electron-smoke-utils.mjs');
const PACKAGE_PATH = path.resolve(__dirname, '../package.json');

// Static contract over the real-runtime smoke driver (scripts/qa/electron-smoke.mjs).
// The driver must launch the packaged executable with the Chromium sandbox ON and an
// isolated temp --user-data-dir, assert the S2 surface (packaged flag, app:// URL,
// sandboxed webPreferences, userData isolation, single window, preload schema,
// persistent storage incl. relaunch, clipboard round-trip, popup denial, clean
// console), and always tear down (close + delete profile) even on failure.
// The preload schema mirrors electronPreloadContract.test.ts (Task 2) verbatim —
// the driver must not invent its own API list.
const EXPECTED_PRELOAD_SCHEMA = {
  topLevel: [
    'clipboard',
    'getAppVersion',
    'getPlatform',
    'localFile',
    'persistentStorage',
    'platform',
    'versions',
  ],
  clipboard: ['writeText'],
  persistentStorage: ['getItem', 'removeItem', 'setItem'],
  localFile: [
    'clearApplication',
    'close',
    'offChanged',
    'offError',
    'onChanged',
    'onError',
    'open',
    'selectApplication',
  ],
  versions: ['chrome', 'electron', 'node'],
};

/** Split the source at every `_electron.launch(` call site, returning each call's full block. */
function extractLaunchBlocks(source: string): string[] {
  const marker = '_electron.launch(';
  const blocks: string[] = [];
  let from = 0;
  while (true) {
    const start = source.indexOf(marker, from);
    if (start === -1) return blocks;
    let depth = 0;
    let i = start + marker.length - 1;
    for (; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(source.slice(start, i + 1));
    from = i + 1;
  }
}

const driverSource = readFileSync(DRIVER_PATH, 'utf8');
// The helpers module carries the schema literal and process-lifecycle tokens
// (close/kill); the contract below checks the combined driver surface.
const driverSurface = driverSource + readFileSync(DRIVER_UTILS_PATH, 'utf8');

describe('electron smoke driver contract', () => {
  it('exists as a runnable node script wired to qa:electron', () => {
    expect(driverSource).toMatch(/^#!\/usr\/bin\/env node/);
    const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.scripts['qa:electron']).toBe('node scripts/qa/electron-smoke.mjs');
    expect(pkg.devDependencies['playwright']).toMatch(/^1\./);
  });

  it('passes chromiumSandbox: true and an isolated --user-data-dir to every launch', () => {
    const blocks = extractLaunchBlocks(driverSource);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).toContain('chromiumSandbox: true');
      expect(block).toContain('--user-data-dir=');
    }
  });

  it('never passes --no-sandbox to the app', () => {
    expect(driverSurface).not.toMatch(/--no-sandbox/);
  });

  it('mirrors the Task 2 preload API schema instead of inventing its own', () => {
    const literal = driverSurface.match(/const EXPECTED_PRELOAD_SCHEMA = (\{.*?\});/s);
    expect(literal).not.toBeNull();
    const schema = JSON.parse(literal![1]) as Record<string, string[]>;
    expect(schema).toEqual(EXPECTED_PRELOAD_SCHEMA);
  });

  it('asserts the launched argv contains no --no-sandbox switch', () => {
    expect(driverSurface).toMatch(/process\.argv/);
    expect(driverSurface).toMatch(/commandLine\.hasSwitch\(['"]no-sandbox['"]\)/);
  });

  it('asserts isolated userData, packaged flag and sandboxed webPreferences', () => {
    expect(driverSurface).toContain("getPath('userData')");
    expect(driverSurface).toContain('isPackaged');
    expect(driverSurface).toContain('getLastWebPreferences');
    expect(driverSurface).toContain('isVisible()');
  });

  it('compares the isolated userData profile by canonical filesystem path', () => {
    expect(driverSource).toMatch(
      /realpathSync\(mainState\.userData\)\s*===\s*realpathSync\(profileDir\)/,
    );
  });

  it('asserts exactly one window on the final app:// URL', () => {
    expect(driverSurface).toContain('getAllWindows');
    expect(driverSurface).toContain('app://index.html');
  });

  it('exercises persistent storage set/get/remove with relaunch persistence', () => {
    expect(driverSurface).toContain('persistentStorage');
    expect(driverSurface).toMatch(/setItem/);
    expect(driverSurface).toMatch(/getItem/);
    expect(driverSurface).toMatch(/removeItem/);
  });

  it('round-trips clipboard writes and reads', () => {
    expect(driverSurface).toMatch(/clipboard\.writeText/);
    expect(driverSurface).toMatch(/readText/);
  });

  it('verifies window.open does not create a child window', () => {
    expect(driverSurface).toMatch(/window\.open/);
  });

  it('listens to page and main process console output', () => {
    expect(driverSurface).toMatch(/\.on\(['"]console['"]/);
    expect(driverSurface).toMatch(/electronApp\.on\(['"]console['"]/);
  });

  it('attaches process and renderer listeners before firstWindow resolves', () => {
    const launchStart = driverSource.indexOf('async function launchAndProbe');
    const appListeners = driverSource.indexOf('attachAppListeners(electronApp)', launchStart);
    const firstWindow = driverSource.indexOf('electronApp.firstWindow()', launchStart);
    expect(appListeners).toBeGreaterThan(launchStart);
    expect(appListeners).toBeLessThan(firstWindow);
    expect(driverSource).toContain("electronApp.on('window', attachPageListeners)");
  });

  it('fails the smoke when the required receipt cannot be written', () => {
    expect(driverSource).toMatch(/writeFileSync\(RECEIPT_PATH[\s\S]*?catch \{\s*receipt\.pass = false;/);
  });

  it('tears down the app and the temp profile even on failure', () => {
    expect(driverSurface).toMatch(/finally/);
    expect(driverSurface).toMatch(/close\(\)/);
    expect(driverSurface).toMatch(/rmSync|rm\(/);
    expect(driverSurface).toMatch(/recursive: true/);
    expect(driverSurface).toMatch(/kill/);
  });
});
