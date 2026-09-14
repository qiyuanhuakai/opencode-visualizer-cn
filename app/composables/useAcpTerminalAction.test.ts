import { ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackendAdapter } from '../backends/types';
import { useAcpTerminalAction, type AcpTerminalPty } from './useAcpTerminalAction';

const pty: AcpTerminalPty = {
  id: 'auth-pty',
  title: 'Auth',
  command: 'agent',
  args: [],
  cwd: '/repo',
  status: 'running',
  pid: 42,
};

function createFixture(
  methods: Awaited<ReturnType<NonNullable<BackendAdapter['listAgentAuthMethods']>>>,
  acpAgentId = 'agent',
  socket?: Pick<WebSocket, 'readyState' | 'send' | 'addEventListener'>,
) {
  let onExit: ((exitCode: number) => Promise<void>) | undefined;
  const backend: Pick<
    BackendAdapter,
    'listAgentAuthMethods' | 'createAgentAuthPty' | 'authenticateAgent'
  > = {
    listAgentAuthMethods: vi.fn(async () => methods),
    createAgentAuthPty: vi.fn(async () => pty),
    authenticateAgent: vi.fn(async () => undefined),
  };
  let selectedBackend = backend;
  const refreshProviders = vi.fn(async () => undefined);
  const refreshAgents = vi.fn(async () => undefined);
  const setErrorStatus = vi.fn();
  const setStatus = vi.fn();
  const closeProviderManager = vi.fn();
  const ensureShellWindow = vi.fn(async (_pty, windowOptions) => {
    onExit = windowOptions.onExit;
  });
  const action = useAcpTerminalAction({
    activeBackendKind: ref('acp'),
    acpAgentId: ref(acpAgentId),
    backend: () => selectedBackend,
    closeProviderManager,
    afterProviderManagerClose: vi.fn(async () => undefined),
    parsePty: (value) => (value === pty ? pty : null),
    ensureShellWindow,
    socketForPty: () => socket,
    refreshProviders,
    refreshAgents,
    setErrorStatus,
    setStatus,
    translate: (key, params) => `${key}${params?.exitCode ?? ''}`,
    errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
  });
  return {
    backend,
    setBackend: (nextBackend: typeof backend) => {
      selectedBackend = nextBackend;
    },
    refreshProviders,
    refreshAgents,
    setErrorStatus,
    setStatus,
    closeProviderManager,
    ensureShellWindow,
    exit: async (code: number) => onExit?.(code),
    ...action,
  };
}

afterEach(() => vi.useRealTimers());

describe('useAcpTerminalAction', () => {
  it('Given a terminal auth method, When its terminal exits successfully, Then App authenticates and refreshes provider data', async () => {
    const fixture = createFixture([
      { id: 'login', name: 'Agent login', type: 'terminal', args: ['login'] },
    ]);

    await fixture.openAcpAuthTerminal();
    await fixture.exit(0);

    expect(fixture.closeProviderManager).toHaveBeenCalledOnce();
    expect(fixture.ensureShellWindow).toHaveBeenCalledWith(
      pty,
      expect.objectContaining({ title: 'Agent login' }),
    );
    expect(fixture.backend.authenticateAgent).toHaveBeenCalledExactlyOnceWith('login');
    expect(fixture.refreshProviders).toHaveBeenCalledOnce();
    expect(fixture.refreshAgents).toHaveBeenCalledOnce();
    expect(fixture.setStatus).toHaveBeenCalledWith('providerManager.acp.completed');
  });

  it('Given a failed authentication terminal, When it exits, Then failure is shown without authenticating or refreshing', async () => {
    const fixture = createFixture([
      { id: 'login', name: 'Agent login', type: 'terminal', args: ['login'] },
    ]);

    await fixture.openAcpAuthTerminal();
    await fixture.exit(7);

    expect(fixture.setErrorStatus).toHaveBeenCalledWith('providerManager.acp.failed7');
    expect(fixture.backend.authenticateAgent).not.toHaveBeenCalled();
    expect(fixture.refreshProviders).not.toHaveBeenCalled();
  });

  it('Given an invalid PTY response, When terminal setup runs, Then the error is reported and no window opens', async () => {
    const fixture = createFixture([
      { id: 'login', name: 'Agent login', type: 'terminal', args: ['login'] },
    ]);
    fixture.backend.createAgentAuthPty = vi.fn(async () => null);

    await fixture.openAcpAuthTerminal();

    expect(fixture.ensureShellWindow).not.toHaveBeenCalled();
    expect(fixture.setErrorStatus).toHaveBeenCalledWith(
      'ACP authentication PTY response is invalid.',
    );
  });

  it('Given a non-ACP backend, When terminal setup is requested, Then no backend method runs', async () => {
    const fixture = createFixture([]);
    const activeBackendKind = ref<'opencode' | 'codex' | 'acp'>('opencode');
    const action = useAcpTerminalAction({
      activeBackendKind,
      acpAgentId: ref('agent'),
      backend: () => fixture.backend,
      closeProviderManager: fixture.closeProviderManager,
      afterProviderManagerClose: vi.fn(async () => undefined),
      parsePty: () => pty,
      ensureShellWindow: fixture.ensureShellWindow,
      socketForPty: () => undefined,
      refreshProviders: fixture.refreshProviders,
      refreshAgents: fixture.refreshAgents,
      setErrorStatus: fixture.setErrorStatus,
      setStatus: fixture.setStatus,
      translate: (key) => key,
      errorMessage: String,
    });

    await action.openAcpAuthTerminal();

    expect(fixture.backend.listAgentAuthMethods).not.toHaveBeenCalled();
  });

  it('Given the Oh My Pi fallback and an open auth socket, When terminal setup runs, Then initial input and its carriage return are sent in order', async () => {
    vi.useFakeTimers();
    const socket = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      addEventListener: vi.fn(),
    };
    const fixture = createFixture([], 'oh-my-pi', socket);

    await fixture.openAcpAuthTerminal();

    expect(socket.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(socket.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(socket.send).toHaveBeenNthCalledWith(1, '/providers');
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(800);

    expect(socket.send).toHaveBeenNthCalledWith(2, '\r');
    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Given a connecting auth socket, When it opens and closes before the deferred submit, Then stale timer work does not send', async () => {
    vi.useFakeTimers();
    let openHandler: EventListenerOrEventListenerObject | undefined;
    const socket: Omit<
      Pick<WebSocket, 'readyState' | 'send' | 'addEventListener'>,
      'readyState'
    > & {
      readyState: WebSocket['readyState'];
    } = {
      readyState: WebSocket.CONNECTING,
      send: vi.fn(),
      addEventListener: vi.fn((type, listener) => {
        if (type === 'open') openHandler = listener;
      }),
    };
    const fixture = createFixture(
      [
        {
          id: 'login',
          name: 'Agent login',
          type: 'terminal',
          args: [],
          initialInput: '/providers\r',
        },
      ],
      'agent',
      socket,
    );

    await fixture.openAcpAuthTerminal();

    expect(socket.addEventListener).toHaveBeenCalledWith('open', expect.any(Function), {
      once: true,
    });
    expect(vi.getTimerCount()).toBe(0);
    if (typeof openHandler !== 'function') throw new Error('Open listener was not registered.');
    socket.readyState = WebSocket.OPEN;
    openHandler(new Event('open'));

    await vi.advanceTimersByTimeAsync(1_500);
    expect(socket.send).toHaveBeenCalledExactlyOnceWith('/providers');
    expect(vi.getTimerCount()).toBe(1);
    socket.readyState = WebSocket.CLOSED;
    await vi.advanceTimersByTimeAsync(800);

    expect(socket.send).toHaveBeenCalledExactlyOnceWith('/providers');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Given the backend changes during terminal setup, When the terminal exits, Then each ACP operation uses the backend selected at that boundary', async () => {
    const fixture = createFixture([
      { id: 'login', name: 'Agent login', type: 'terminal', args: ['login'] },
    ]);
    const createBackend = {
      ...fixture.backend,
      createAgentAuthPty: vi.fn(async () => {
        fixture.setBackend(authenticateBackend);
        return pty;
      }),
    };
    const authenticateBackend = {
      ...fixture.backend,
      authenticateAgent: vi.fn(async () => undefined),
    };
    fixture.backend.listAgentAuthMethods = vi.fn(async () => {
      fixture.setBackend(createBackend);
      return [{ id: 'login', name: 'Agent login', type: 'terminal', args: ['login'] }];
    });

    await fixture.openAcpAuthTerminal();
    await fixture.exit(0);

    expect(createBackend.createAgentAuthPty).toHaveBeenCalledExactlyOnceWith('login');
    expect(authenticateBackend.authenticateAgent).toHaveBeenCalledExactlyOnceWith('login');
    expect(fixture.backend.authenticateAgent).not.toHaveBeenCalled();
  });
});
