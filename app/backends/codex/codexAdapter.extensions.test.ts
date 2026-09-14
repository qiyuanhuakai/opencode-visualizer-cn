import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexAdapter, normalizeCodexMcpServerInfo } from './codexAdapter';
import {
  closeCodexTestSockets,
  CodexTestSocket as MockWebSocket,
  waitForSent,
} from './codexTestSocket';

describe('CodexAdapter', () => {
  afterEach(closeCodexTestSockets);

  describe('updateSkill', () => {
    it('sends skills/config/write with the supplied path and enabled flag', async () => {
      MockWebSocket.instances = [];
      const adapter = createCodexAdapter({
        url: 'ws://localhost:4500',
        webSocketCtor: MockWebSocket,
      });

      const update = adapter.updateSkill({
        path: '/Users/me/.codex/skills/skill-creator/SKILL.md',
        enabled: false,
      });
      const socket = MockWebSocket.instances[0]!;
      socket.emitOpen();
      await waitForSent(socket, 1);
      socket.respond(1, {});
      await waitForSent(socket, 3);
      socket.respond(2, {});

      await expect(update).resolves.toEqual({
        path: '/Users/me/.codex/skills/skill-creator/SKILL.md',
        enabled: false,
      });
      expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
        id: 2,
        method: 'skills/config/write',
        params: {
          path: '/Users/me/.codex/skills/skill-creator/SKILL.md',
          enabled: false,
        },
      });
    });

    it('throws when path is missing (Codex keys the write by path)', async () => {
      MockWebSocket.instances = [];
      const adapter = createCodexAdapter({
        url: 'ws://localhost:4500',
        webSocketCtor: MockWebSocket,
      });

      await expect(adapter.updateSkill({ path: '', enabled: true })).rejects.toThrow(/path/);
    });
  });

  describe('getMcpStatus', () => {
    it('normalizes the current MCP wire inventory for the manager UI', () => {
      expect(
        normalizeCodexMcpServerInfo({
          name: 'officecli',
          serverInfo: { name: 'officecli', version: '1.0.0' },
          tools: { convert_to_pdf: { name: 'convert_to_pdf', description: 'Convert a file.' } },
          resources: [{ name: 'templates', description: 'Office templates' }],
          resourceTemplates: [],
          authStatus: 'unsupported',
        }),
      ).toEqual({
        name: 'officecli',
        status: 'connected',
        tools: [{ name: 'convert_to_pdf', description: 'Convert a file.' }],
        resources: [{ name: 'templates', description: 'Office templates' }],
        auth: { type: 'none', status: 'completed' },
      });
    });

    it('normalizes notLoggedIn as an OAuth action requirement', () => {
      expect(
        normalizeCodexMcpServerInfo({
          name: 'remote',
          serverInfo: null,
          tools: {},
          resources: [],
          resourceTemplates: [],
          authStatus: 'notLoggedIn',
        }),
      ).toEqual({
        name: 'remote',
        status: 'needs_auth',
        tools: [],
        resources: [],
        auth: { type: 'oauth', status: 'required' },
      });
    });

    async function expectMcpListStatus(
      entry: Record<string, unknown>,
      expected: 'connected' | 'configured' | 'needs_auth',
    ) {
      MockWebSocket.instances = [];
      const adapter = createCodexAdapter({
        url: 'ws://localhost:4500',
        webSocketCtor: MockWebSocket,
      });

      const status = adapter.getMcpStatus();
      const socket = MockWebSocket.instances[0]!;
      socket.emitOpen();
      await waitForSent(socket, 1);
      socket.respond(1, {});
      await waitForSent(socket, 3);
      socket.respond(2, { config: {} });
      await waitForSent(socket, 4);
      socket.respond(3, { data: [{ name: 'server-a', ...entry }], nextCursor: null });

      const result = await status;
      expect(result['server-a']?.status).toBe(expected);
    }

    it('maps the current inventory wire shape to connected', async () => {
      await expectMcpListStatus(
        {
          serverInfo: { name: 'officecli', version: '1.0.0' },
          tools: { convert_to_pdf: { name: 'convert_to_pdf' } },
          resources: [],
          resourceTemplates: [],
          authStatus: 'unsupported',
        },
        'connected',
      );
    });

    it('maps notLoggedIn auth status to needs_auth', async () => {
      await expectMcpListStatus(
        {
          serverInfo: null,
          tools: {},
          resources: [],
          resourceTemplates: [],
          authStatus: 'notLoggedIn',
        },
        'needs_auth',
      );
    });

    it('keeps an inventory entry without connection evidence as configured', async () => {
      await expectMcpListStatus(
        {
          serverInfo: null,
          tools: {},
          resources: [],
          resourceTemplates: [],
          authStatus: 'unsupported',
        },
        'configured',
      );
    });

    it('falls back to configured MCP entries when the supported status call does not terminate', async () => {
      vi.useFakeTimers();
      try {
        MockWebSocket.instances = [];
        const adapter = createCodexAdapter({
          url: 'ws://localhost:4500',
          webSocketCtor: MockWebSocket,
          mcpStatusTimeoutMs: 20,
        });

        const status = adapter.getMcpStatus();
        const socket = MockWebSocket.instances[0]!;
        socket.emitOpen();
        await waitForSent(socket, 1);
        socket.respond(1, {});
        await waitForSent(socket, 3);
        expect(JSON.parse(socket.sent[2] ?? '{}')).toMatchObject({
          method: 'config/read',
        });
        socket.respond(2, {
          config: {
            mcp_servers: {
              officecli: { command: 'officecli', args: ['mcp'], enabled: true },
            },
          },
        });
        await waitForSent(socket, 4);
        expect(JSON.parse(socket.sent[3] ?? '{}')).toMatchObject({
          method: 'mcpServerStatus/list',
          params: { detail: 'toolsAndAuthOnly' },
        });

        await vi.advanceTimersByTimeAsync(20);

        await expect(status).resolves.toEqual({
          officecli: { status: 'configured' },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('uses the live MCP inventory when cold startup exceeds three seconds', async () => {
      vi.useFakeTimers();
      try {
        MockWebSocket.instances = [];
        const adapter = createCodexAdapter({
          url: 'ws://localhost:4500',
          webSocketCtor: MockWebSocket,
        });

        const status = adapter.getMcpStatus();
        const socket = MockWebSocket.instances[0]!;
        socket.emitOpen();
        await waitForSent(socket, 1);
        socket.respond(1, {});
        await waitForSent(socket, 3);
        socket.respond(2, {
          config: {
            mcp_servers: {
              officecli: { command: 'officecli', args: ['mcp'], enabled: true },
            },
          },
        });
        await waitForSent(socket, 4);

        await vi.advanceTimersByTimeAsync(3_001);
        const liveServers = [
          { name: 'codegraph', authStatus: 'unsupported', tool: 'codegraph_explore' },
          { name: 'codex_apps', authStatus: 'bearerToken', tool: 'sites.get_site' },
          { name: 'context7', authStatus: 'notLoggedIn', tool: 'query-docs' },
          { name: 'git_bash', authStatus: 'unsupported', tool: '' },
          { name: 'grep_app', authStatus: 'unsupported', tool: 'searchGitHub' },
          { name: 'lsp', authStatus: 'unsupported', tool: 'diagnostics' },
          { name: 'officecli', authStatus: 'unsupported', tool: 'officecli' },
        ] as const;
        socket.respond(3, {
          data: liveServers.map(({ name, authStatus, tool }) => ({
            name,
            serverInfo: tool ? { name, version: 'live' } : null,
            tools: tool ? { [tool]: { name: tool } } : {},
            resources: [],
            resourceTemplates: [],
            authStatus,
          })),
          nextCursor: null,
        });

        await expect(status).resolves.toEqual({
          codegraph: { status: 'connected' },
          codex_apps: { status: 'connected' },
          context7: { status: 'needs_auth' },
          git_bash: { status: 'configured' },
          grep_app: { status: 'connected' },
          lsp: { status: 'connected' },
          officecli: { status: 'connected' },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('preserves method-not-found so the UI can render MCP as unsupported', async () => {
      MockWebSocket.instances = [];
      const adapter = createCodexAdapter({
        url: 'ws://localhost:4500',
        webSocketCtor: MockWebSocket,
      });

      const status = adapter.getMcpStatus();
      const socket = MockWebSocket.instances[0]!;
      socket.emitOpen();
      await waitForSent(socket, 1);
      socket.respond(1, {});
      await waitForSent(socket, 3);
      socket.respond(2, { config: {} });
      await waitForSent(socket, 4);
      socket.reject(3, 'Method not found', -32601);

      await expect(status).rejects.toMatchObject({ code: -32601 });
    });
  });

  it('normalizes the current plugin/list wire fields at the adapter boundary', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });
    const plugins = adapter.listPlugins();
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 2);
    socket.respond(2, {
      marketplaces: [
        {
          name: 'sisyphuslabs',
          path: '/home/test/.codex/plugins/cache/sisyphuslabs/marketplace.json',
          interface: null,
          plugins: [
            {
              id: 'omo@sisyphuslabs',
              remotePluginId: null,
              version: null,
              localVersion: '4.19.1',
              name: 'omo',
              source: { type: 'local', path: '/home/test/.codex/plugins/omo/4.19.1' },
              installed: true,
              enabled: true,
              availability: 'AVAILABLE',
              interface: {
                displayName: 'OMO',
                shortDescription: 'Unified local Codex components',
                logoUrl: 'https://example.test/omo.png',
              },
              keywords: ['codex', 'mcp'],
            },
            {
              id: 'admin-disabled@sisyphuslabs',
              name: 'admin-disabled',
              source: { type: 'remote' },
              installed: true,
              enabled: true,
              availability: 'DISABLED_BY_ADMIN',
              interface: { shortDescription: 'Disabled by policy' },
              keywords: [],
            },
          ],
        },
        { name: 'openai-curated-remote', path: null, interface: null, plugins: [] },
      ],
      marketplaceLoadErrors: [{ marketplaceName: 'broken-marketplace', error: 'unavailable' }],
      featuredPluginIds: ['omo@sisyphuslabs'],
    });
    await expect(plugins).resolves.toEqual({
      marketplaces: [
        {
          name: 'sisyphuslabs',
          path: '/home/test/.codex/plugins/cache/sisyphuslabs/marketplace.json',
          plugins: [
            expect.objectContaining({
              id: 'omo@sisyphuslabs',
              name: 'omo',
              description: 'Unified local Codex components',
              logoUrl: 'https://example.test/omo.png',
              isAccessible: true,
              isEnabled: true,
              state: 'installed',
            }),
            expect.objectContaining({
              id: 'admin-disabled@sisyphuslabs',
              isAccessible: false,
              isEnabled: false,
              state: 'installed',
            }),
          ],
        },
        { name: 'openai-curated-remote', path: null, plugins: [] },
      ],
      errors: [{ marketplaceName: 'broken-marketplace', error: 'unavailable' }],
      featured: ['omo@sisyphuslabs'],
    });
  });

  it('writes MCP config under the live mcp_servers key', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });
    const update = adapter.updateMcp({
      name: 'officecli',
      config: { command: 'officecli', enabled: false },
    });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
      id: 2,
      method: 'config/value/write',
      params: {
        keyPath: 'mcp_servers.officecli',
        value: { command: 'officecli', enabled: false },
        mergeStrategy: 'replace',
      },
    });
    socket.respond(2, {});
    await waitForSent(socket, 4);
    socket.respond(3, {});
    await expect(update).resolves.toEqual({});
  });
});
