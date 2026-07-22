import { describe, expect, it } from 'vitest';
import { initializeAdapterWithOptions } from './acpTestHarness';

const KIMI_ADVERTISED_AUTH_METHODS = [
  {
    id: 'login',
    type: 'terminal',
    name: 'Login with Kimi account',
    description: 'Open the device-code login flow in a terminal.',
    args: ['--login'],
    env: {},
    _meta: {
      'terminal-auth': {
        type: 'terminal',
        label: 'Login with Kimi account',
        command: 'kimi',
        args: ['login'],
        env: {},
      },
    },
  },
];

describe('AcpAdapter.listAgentAuthMethods', () => {
  it('replaces kimi-code\'s broken --login method with an interactive TUI setup terminal', async () => {
    // kimi --login does not exist ("unknown option --login"); providers are
    // configured in the interactive TUI via the /provider page.
    const { adapter } = await initializeAdapterWithOptions({
      agentId: 'kimi-code',
      initializeAuthMethods: KIMI_ADVERTISED_AUTH_METHODS,
    });

    const methods = await adapter.listAgentAuthMethods();

    expect(methods).toHaveLength(1);
    expect(methods[0]).toMatchObject({
      type: 'terminal',
      args: [],
      initialInput: '/provider\r',
    });
    expect(methods[0]?.args).not.toContain('--login');
  });

  it('keeps agent-advertised methods for agents without a known override', async () => {
    const { adapter } = await initializeAdapterWithOptions({
      agentId: 'other-agent',
      initializeAuthMethods: [
        { id: 'oauth', type: 'terminal', name: 'OAuth login', args: ['--oauth'] },
      ],
    });

    const methods = await adapter.listAgentAuthMethods();

    expect(methods).toEqual([
      expect.objectContaining({ id: 'oauth', args: ['--oauth'] }),
    ]);
  });

  it('adds /providers initial input to Oh My Pi\'s advertised terminal method, keeping its args', async () => {
    // Current OMP advertises the terminal method only when the client declares
    // clientCapabilities.auth.terminal; args must be preserved, input added.
    const { adapter } = await initializeAdapterWithOptions({
      agentId: 'oh-my-pi',
      initializeAuthMethods: [
        { id: 'agent', name: 'Use existing local credentials' },
        {
          type: 'terminal',
          id: 'terminal',
          name: 'Set up Oh My Pi in terminal',
          args: ['--acp-terminal-auth'],
        },
      ],
    });

    const methods = await adapter.listAgentAuthMethods();

    const terminal = methods.find((method) => method.type === 'terminal');
    expect(terminal).toMatchObject({
      id: 'terminal',
      args: ['--acp-terminal-auth'],
      initialInput: '/providers\r',
    });
  });

  it('replaces the Oh My Pi fallback with an interactive TUI plus /providers input', async () => {
    // omp --acp-auth-terminal is an unknown flag on current OMP; provider setup
    // lives in the interactive TUI via the /providers command.
    const { adapter } = await initializeAdapterWithOptions({ agentId: 'oh-my-pi' });

    const methods = await adapter.listAgentAuthMethods();

    expect(methods).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: 'terminal',
        args: [],
        initialInput: '/providers\r',
      }),
    ]);
    expect(methods[0]?.args).not.toContain('--acp-auth-terminal');
  });
});
