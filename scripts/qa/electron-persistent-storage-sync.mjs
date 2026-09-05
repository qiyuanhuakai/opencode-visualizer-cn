#!/usr/bin/env node
import { _electron } from 'playwright';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STORAGE_FILE = 'renderer-storage.json';
const STORAGE_KEY = 'pr113.sync-storage-key';
const STORAGE_VALUE = 'recovered-in-place';
const READ_TIMEOUT_MS = 3000;
const CLOSE_TIMEOUT_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function closeBounded(app) {
  if (!app) return;
  const processRef = app.process();
  const exited = new Promise((resolve) => processRef.once('exit', resolve));
  app.close().catch(() => {});
  const outcome = await Promise.race([exited, sleep(CLOSE_TIMEOUT_MS)]);
  if (outcome === undefined) {
    try {
      processRef.kill('SIGKILL');
    } catch {}
    await Promise.race([exited, sleep(1000)]);
  }
}

async function evaluateStorageGet(page) {
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`storage get exceeded ${READ_TIMEOUT_MS}ms`)),
      READ_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([
      page.evaluate((key) => {
        try {
          return { kind: 'value', value: window['electronAPI'].persistentStorage.getItem(key) };
        } catch (error) {
          return { kind: 'error', name: error?.name, message: error?.message };
        }
      }, STORAGE_KEY),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const executablePath = process.env.VIS_ELECTRON_EXECUTABLE;
  if (!executablePath) {
    throw new Error(
      'VIS_ELECTRON_EXECUTABLE is required: run pnpm electron:preview first and point it at the unpacked executable',
    );
  }

  const profileDir = mkdtempSync(path.join(tmpdir(), 'vis-electron-sync-storage-'));
  const storagePath = path.join(profileDir, STORAGE_FILE);
  const malformedBytes = Buffer.from([0xc3, 0x28, 0xff, 0xfe]);
  writeFileSync(storagePath, malformedBytes);
  let app;
  const result = {
    storagePath,
    malformedBytesPreserved: false,
    malformedRead: null,
    recoveredRead: null,
    sameProcessRecovery: false,
  };

  try {
    app = await _electron.launch({
      executablePath,
      args: [`--user-data-dir=${profileDir}`],
      chromiumSandbox: true,
      timeout: 90000,
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('load');

    result.malformedRead = await evaluateStorageGet(page);
    result.malformedBytesPreserved = readFileSync(storagePath).equals(malformedBytes);
    assert(
      result.malformedRead?.kind === 'error',
      `malformed read did not fail locally: ${JSON.stringify(result.malformedRead)}`,
    );
    assert(
      result.malformedBytesPreserved,
      'malformed native storage bytes changed during failed get',
    );

    writeFileSync(storagePath, JSON.stringify({ [STORAGE_KEY]: STORAGE_VALUE }));
    result.recoveredRead = await evaluateStorageGet(page);
    assert(
      result.recoveredRead?.kind === 'value',
      `corrected storage did not return a value: ${JSON.stringify(result.recoveredRead)}`,
    );
    assert(
      result.recoveredRead.value === STORAGE_VALUE,
      `corrected storage returned the wrong value: ${JSON.stringify(result.recoveredRead)}`,
    );
    result.sameProcessRecovery = true;
    console.log(JSON.stringify({ pass: true, ...result }, null, 2));
  } finally {
    await closeBounded(app);
    rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`SYNC STORAGE FAIL - ${error.stack ?? error}`);
  process.exitCode = 1;
});
