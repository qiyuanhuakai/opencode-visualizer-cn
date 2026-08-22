import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'App.vue'), 'utf8');

describe('App PTY lifecycle invalidation contract', () => {
  it('invalidates pending ownership when removing a PTY window', () => {
    expect(appSource).toContain('pendingShellWindowCreates.invalidate(ptyId);');
  });

  it('invalidates all pending ownership on renderer unmount', () => {
    expect(appSource).toContain('pendingShellWindowCreates.invalidateAll();');
  });

  it('opens the window only after the dynamic terminal import is current', () => {
    const importIndex = appSource.indexOf("const { Terminal } = await import('@xterm/xterm');");
    const openIndex = appSource.indexOf('fw.open(key, {', importIndex);
    expect(importIndex).toBeGreaterThan(-1);
    expect(openIndex).toBeGreaterThan(importIndex);
  });

  it('does not publish stale exit callbacks or window sizing metadata', () => {
    const importIndex = appSource.indexOf("const { Terminal } = await import('@xterm/xterm');");
    const exitCallbackIndex = appSource.indexOf('shellExitCallbacks.set(pty.id, options.onExit)');
    const minimumsIndex = appSource.indexOf('shellWindowMinimums.set(key, {');
    expect(exitCallbackIndex).toBeGreaterThan(importIndex);
    expect(minimumsIndex).toBeGreaterThan(importIndex);
  });

  it('keeps unmount cleanup separate from backend PTY deletion', () => {
    expect(appSource).toContain('disposeShellWindows();');
    expect(appSource).toContain('removeShellWindow(ptyId);');
  });
});
