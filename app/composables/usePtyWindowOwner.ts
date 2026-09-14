type PendingPtyCreateRegistry = {
  readonly getOrCreate: (
    id: string,
    factory: (isCurrent: () => boolean) => Promise<void>,
  ) => Promise<void>;
  readonly invalidate: (id: string) => void;
  readonly invalidateAll: () => void;
};

type RemoveWindowOptions = {
  readonly kill?: boolean;
};

type CleanupWindowOptions = {
  readonly kill: boolean;
};

type PtyWindowOwnerOptions<
  Pty extends { readonly id: string },
  Terminal extends { readonly dispose: () => void },
  Session extends { readonly terminal: Terminal },
  TerminalOptions,
  WindowOptions,
  Host,
> = {
  readonly sessions: Map<string, Session>;
  readonly pendingCreates: PendingPtyCreateRegistry;
  readonly loadTerminal: () => Promise<(options: TerminalOptions) => Terminal>;
  readonly createTerminalOptions: (pty: Pty) => TerminalOptions;
  readonly prepareWindow: (pty: Pty, options: WindowOptions) => void;
  readonly openWindow: (pty: Pty, options: WindowOptions) => void;
  readonly closeWindow: (ptyId: string) => void;
  readonly createSession: (pty: Pty, terminal: Terminal) => Session;
  readonly connectSession: (ptyId: string) => void;
  readonly queueAfterRender: (callback: () => void) => void;
  readonly waitForFontsReady: () => Promise<void>;
  readonly findTerminalHost: (ptyId: string) => Host | null;
  readonly openTerminal: (terminal: Terminal, host: Host) => void;
  readonly requestFrame: (callback: () => void) => void;
  readonly resizeWindow: (ptyId: string, terminal: Terminal, host: Host) => void;
  readonly cleanupSession: (ptyId: string, session: Session, options: CleanupWindowOptions) => void;
};

export function usePtyWindowOwner<
  Pty extends { readonly id: string },
  Terminal extends { readonly dispose: () => void },
  Session extends { readonly terminal: Terminal },
  TerminalOptions,
  WindowOptions,
  Host,
>(options: PtyWindowOwnerOptions<Pty, Terminal, Session, TerminalOptions, WindowOptions, Host>) {
  async function ensureWindow(pty: Pty, windowOptions: WindowOptions): Promise<void> {
    if (options.sessions.has(pty.id)) return;
    await options.pendingCreates.getOrCreate(pty.id, async (isCurrent) => {
      if (options.sessions.has(pty.id)) return;

      const createTerminal = await options.loadTerminal();
      if (!isCurrent()) return;

      options.prepareWindow(pty, windowOptions);
      options.openWindow(pty, windowOptions);
      const terminal = createTerminal(options.createTerminalOptions(pty));
      if (!isCurrent()) {
        terminal.dispose();
        options.closeWindow(pty.id);
        return;
      }

      options.sessions.set(pty.id, options.createSession(pty, terminal));
      options.connectSession(pty.id);
      options.queueAfterRender(() => {
        void options.waitForFontsReady().then(() => {
          if (options.sessions.get(pty.id)?.terminal !== terminal) {
            terminal.dispose();
            return;
          }
          const host = options.findTerminalHost(pty.id);
          if (host === null) return;
          options.openTerminal(terminal, host);
          options.requestFrame(() => options.resizeWindow(pty.id, terminal, host));
        });
      });
    });
  }

  function removeWindow(ptyId: string, removeOptions: RemoveWindowOptions = {}): void {
    options.pendingCreates.invalidate(ptyId);
    const session = options.sessions.get(ptyId);
    if (!session) return;
    options.cleanupSession(ptyId, session, { kill: removeOptions.kill === true });
  }

  function dispose(): void {
    options.pendingCreates.invalidateAll();
    for (const ptyId of Array.from(options.sessions.keys())) removeWindow(ptyId);
  }

  return { ensureWindow, removeWindow, dispose };
}
