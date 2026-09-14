import { describe, expect, it, vi } from 'vitest';

import { createPendingPtyCreateRegistry } from '../utils/ptyLifecycle';
import { usePtyWindowOwner } from './usePtyWindowOwner';

type TestPty = {
  readonly id: string;
};

type TestTerminal = {
  readonly id: number;
  disposed: number;
  readonly dispose: () => void;
};

type TestSession = {
  readonly terminal: TestTerminal;
};

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createFixture() {
  const sessions = new Map<string, TestSession>();
  const windows = new Set<string>();
  const pendingCreates = createPendingPtyCreateRegistry<void>();
  const preparedPtys: string[] = [];
  const importGate = deferred<void>();
  const fontGates: Array<ReturnType<typeof deferred<void>>> = [];
  const terminals: TestTerminal[] = [];
  const cleanupCalls: Array<{ readonly id: string; readonly kill: boolean }> = [];
  const loadTerminal = vi.fn(async () => {
    await importGate.promise;
    return (options: { readonly id: number }) => {
      const terminal: TestTerminal = {
        id: options.id,
        disposed: 0,
        dispose() {
          terminal.disposed += 1;
        },
      };
      terminals.push(terminal);
      return terminal;
    };
  });

  const owner = usePtyWindowOwner<
    TestPty,
    TestTerminal,
    TestSession,
    { readonly id: number },
    void,
    object
  >({
    sessions,
    pendingCreates,
    loadTerminal,
    createTerminalOptions: () => ({ id: terminals.length + 1 }),
    prepareWindow: (pty) => preparedPtys.push(pty.id),
    openWindow: (pty) => windows.add(pty.id),
    closeWindow: (ptyId) => windows.delete(ptyId),
    createSession: (_pty, terminal) => ({ terminal }),
    connectSession: () => undefined,
    queueAfterRender: (callback) => callback(),
    waitForFontsReady: () => {
      const gate = deferred<void>();
      fontGates.push(gate);
      return gate.promise;
    },
    findTerminalHost: () => ({}),
    openTerminal: () => undefined,
    requestFrame: (callback) => callback(),
    resizeWindow: () => undefined,
    cleanupSession: (ptyId, session, options) => {
      session.terminal.dispose();
      sessions.delete(ptyId);
      windows.delete(ptyId);
      cleanupCalls.push({ id: ptyId, kill: options.kill });
    },
  });

  return {
    cleanupCalls,
    fontGates,
    importGate,
    loadTerminal,
    owner,
    preparedPtys,
    sessions,
    terminals,
    windows,
  };
}

describe('usePtyWindowOwner', () => {
  it('Given duplicate creates, When the terminal import resolves, Then one PTY window is committed', async () => {
    const fixture = createFixture();

    const first = fixture.owner.ensureWindow({ id: 'pty-1' });
    const second = fixture.owner.ensureWindow({ id: 'pty-1' });
    fixture.importGate.resolve();
    await Promise.all([first, second]);

    expect(fixture.loadTerminal).toHaveBeenCalledTimes(1);
    expect(fixture.terminals).toHaveLength(1);
    expect(fixture.windows).toEqual(new Set(['pty-1']));
  });

  it('Given a pending import, When its PTY is removed, Then the old window is never created', async () => {
    const fixture = createFixture();

    const creation = fixture.owner.ensureWindow({ id: 'pty-1' });
    fixture.owner.removeWindow('pty-1');
    fixture.importGate.resolve();
    await creation;

    expect(fixture.terminals).toHaveLength(0);
    expect(fixture.preparedPtys).toEqual([]);
    expect(fixture.windows).toEqual(new Set());
  });

  it('Given a pending import, When its PTY is replaced, Then only the replacement window is created', async () => {
    const fixture = createFixture();

    const oldCreation = fixture.owner.ensureWindow({ id: 'pty-1' });
    fixture.owner.removeWindow('pty-1');
    const replacementCreation = fixture.owner.ensureWindow({ id: 'pty-1' });
    fixture.importGate.resolve();
    await Promise.all([oldCreation, replacementCreation]);

    expect(fixture.loadTerminal).toHaveBeenCalledTimes(2);
    expect(fixture.terminals).toHaveLength(1);
    expect(fixture.preparedPtys).toEqual(['pty-1']);
    expect(fixture.sessions.get('pty-1')?.terminal).toBe(fixture.terminals[0]);
    expect(fixture.windows).toEqual(new Set(['pty-1']));
  });

  it('Given an old font callback, When the PTY is replaced, Then destroying the old terminal keeps the new window', async () => {
    const fixture = createFixture();
    fixture.importGate.resolve();
    await fixture.owner.ensureWindow({ id: 'pty-1' });
    const oldTerminal = fixture.terminals[0];

    fixture.owner.removeWindow('pty-1');
    await fixture.owner.ensureWindow({ id: 'pty-1' });
    const replacementTerminal = fixture.terminals[1];
    fixture.fontGates[0]?.resolve();
    await Promise.resolve();

    expect(oldTerminal?.disposed).toBeGreaterThan(0);
    expect(replacementTerminal?.disposed).toBe(0);
    expect(fixture.sessions.get('pty-1')?.terminal).toBe(replacementTerminal);
    expect(fixture.windows).toEqual(new Set(['pty-1']));
  });

  it('Given renderer-owned PTY windows, When the owner disposes, Then cleanup does not delete backend PTYs', async () => {
    const fixture = createFixture();
    fixture.importGate.resolve();
    await fixture.owner.ensureWindow({ id: 'pty-1' });

    fixture.owner.dispose();

    expect(fixture.cleanupCalls).toEqual([{ id: 'pty-1', kill: false }]);
    expect(fixture.sessions).toEqual(new Map());
  });
});
