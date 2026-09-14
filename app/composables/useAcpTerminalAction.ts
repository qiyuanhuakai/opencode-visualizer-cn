import type { Ref } from 'vue';
import type { AgentAuthMethod, BackendAdapter, BackendKind } from '../backends/types';

export type AcpTerminalPty = {
  readonly id: string;
  readonly title: string;
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly status: 'running' | 'exited';
  readonly pid: number;
};

type AcpAuthSocket = Pick<WebSocket, 'readyState' | 'send' | 'addEventListener'>;
type AcpAuthBackend = Pick<
  BackendAdapter,
  'listAgentAuthMethods' | 'createAgentAuthPty' | 'authenticateAgent'
>;

type AcpTerminalActionOptions = {
  readonly activeBackendKind: Ref<BackendKind>;
  readonly acpAgentId: Ref<string>;
  readonly backend: () => AcpAuthBackend;
  readonly closeProviderManager: () => void;
  readonly afterProviderManagerClose: () => Promise<void>;
  readonly parsePty: (value: unknown) => AcpTerminalPty | null;
  readonly ensureShellWindow: (
    pty: AcpTerminalPty,
    options: {
      readonly title: string;
      readonly onExit: (exitCode: number) => Promise<void>;
    },
  ) => Promise<void>;
  readonly socketForPty: (ptyId: string) => AcpAuthSocket | undefined;
  readonly refreshProviders: () => Promise<unknown>;
  readonly refreshAgents: () => Promise<unknown>;
  readonly setErrorStatus: (message: string) => void;
  readonly setStatus: (message: string) => void;
  readonly translate: (key: string, params?: Record<string, unknown>) => string;
  readonly errorMessage: (error: unknown) => string;
};

function requireMethod<T>(method: T | undefined, name: string): T {
  if (!method) throw new Error(`Active backend does not support ${name}.`);
  return method;
}

export function useAcpTerminalAction(options: AcpTerminalActionOptions) {
  async function openAcpAuthTerminal() {
    if (options.activeBackendKind.value !== 'acp') return;
    try {
      const listMethods = requireMethod(
        options.backend().listAgentAuthMethods,
        'ACP authentication methods',
      );
      const methods = await listMethods();
      const method: AgentAuthMethod | undefined =
        methods.find(
          (candidate) =>
            candidate.type === 'terminal' &&
            (Boolean(candidate.args?.length) || Boolean(candidate.initialInput)),
        ) ??
        (options.acpAgentId.value === 'oh-my-pi'
          ? {
              type: 'terminal',
              id: 'terminal',
              name: 'Set up Oh My Pi in terminal',
              args: [],
              initialInput: '/providers\r',
            }
          : undefined);
      if (!method) throw new Error(options.translate('providerManager.acp.unavailable'));

      options.closeProviderManager();
      await options.afterProviderManagerClose();
      const createAuthPty = requireMethod(
        options.backend().createAgentAuthPty,
        'ACP terminal authentication',
      );
      const pty = options.parsePty(await createAuthPty(method.id));
      if (!pty) throw new Error('ACP authentication PTY response is invalid.');
      await options.ensureShellWindow(pty, {
        title: method.name,
        onExit: async (exitCode) => {
          if (exitCode !== 0) {
            options.setErrorStatus(options.translate('providerManager.acp.failed', { exitCode }));
            return;
          }
          if (!method.initialInput) {
            const authenticate = requireMethod(
              options.backend().authenticateAgent,
              'ACP authentication completion',
            );
            await authenticate(method.id);
          }
          await Promise.all([options.refreshProviders(), options.refreshAgents()]);
          options.setStatus(options.translate('providerManager.acp.completed'));
        },
      });

      if (method.initialInput) sendInitialInput(options.socketForPty(pty.id), method.initialInput);
    } catch (error) {
      options.setErrorStatus(options.errorMessage(error));
    }
  }

  return { openAcpAuthTerminal };
}

function sendInitialInput(socket: AcpAuthSocket | undefined, initialInput: string) {
  if (!socket) return;
  const send = () => {
    window.setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const text = initialInput.replace(/\r$/u, '');
      if (text) socket.send(text);
      if (initialInput.endsWith('\r')) {
        window.setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send('\r');
        }, 800);
      }
    }, 1500);
  };
  if (socket.readyState === WebSocket.OPEN) send();
  else socket.addEventListener('open', send, { once: true });
}
