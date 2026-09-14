import { beforeEach, describe, expect, it } from 'vitest';
import { useCodexApi } from './useCodexApi';
import { createAdapterMock, resetCodexApiTestState } from './useCodexApi.test-helpers';

describe('useCodexApi', () => {
  beforeEach(resetCodexApiTestState);

  it('tracks and resolves server-initiated approval requests', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Needs approval.');
    mock.emitServerRequest({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
        itemId: 'item_1',
        command: ['pnpm', 'test'],
        availableDecisions: ['accept', 'decline', 'unexpected'],
      },
    });

    expect(api.serverRequests.value).toEqual([
      expect.objectContaining({
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        threadId: 'thr_existing',
        turnId: 'turn_1',
        availableDecisions: ['accept', 'decline'],
      }),
    ]);

    api.resolveServerRequest('approval-1', 'acceptForSession');
    expect(mock.adapter.respondToServerRequest).not.toHaveBeenCalled();

    api.resolveServerRequest('approval-1', 'accept');

    expect(mock.adapter.respondToServerRequest).toHaveBeenCalledWith('approval-1', {
      decision: 'accept',
    });
    expect(api.serverRequests.value).toEqual([]);
  });

  it('ignores unsupported or out-of-scope server requests', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Needs scoped approval.');
    mock.emitServerRequest({
      id: 'wrong-thread',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_other',
        turnId: 'turn_1',
        availableDecisions: ['accept'],
      },
    });
    mock.emitServerRequest({
      id: 'missing-decisions',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
      },
    });
    mock.emitServerRequest({
      id: 'unsupported-method',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
        availableDecisions: ['accept'],
      },
    });

    expect(api.serverRequests.value).toEqual([]);
  });

  it('clears stale approvals when the active thread or turn changes', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Needs scoped approval.');
    mock.emitServerRequest({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
        availableDecisions: ['accept'],
      },
    });

    expect(api.serverRequests.value).toHaveLength(1);

    mock.emit({ method: 'turn/started', params: { turn: { id: 'turn_2', status: 'inProgress' } } });

    expect(api.serverRequests.value).toEqual([]);
    api.resolveServerRequest('approval-1', 'accept');
    expect(mock.adapter.respondToServerRequest).not.toHaveBeenCalled();

    mock.emitServerRequest({
      id: 'approval-2',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_2',
        availableDecisions: ['decline'],
      },
    });
    expect(api.serverRequests.value).toHaveLength(1);

    await api.startThread();

    expect(api.serverRequests.value).toEqual([]);
  });

  describe('typed Codex server requests', () => {
    it('queues and answers structured permission requests with the requested profile', async () => {
      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      mock.emitServerRequest({
        id: 7,
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_1',
          itemId: 'permission-item',
          startedAtMs: 123,
          cwd: '/repo',
          reason: 'Need network access',
          permissions: { network: { enabled: true } },
        },
      });

      expect(api.permissionRequests.value).toHaveLength(1);
      expect(api.permissionRequests.value[0]).toMatchObject({
        dialogId: 'codex-permission:number:7',
        sessionID: 'thr_existing',
        requestedPermissions: { network: { enabled: true } },
      });

      api.replyPermissionRequest('codex-permission:number:7', 'always');

      expect(mock.adapter.respondToServerRequest).toHaveBeenCalledWith(7, {
        permissions: { network: { enabled: true } },
        scope: 'session',
      });
      expect(api.permissionRequests.value).toEqual([]);
    });

    it('queues and answers MCP form elicitations without persisting answers', async () => {
      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      mock.emitServerRequest({
        id: 'elicitation-1',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_1',
          serverName: 'deployments',
          mode: 'form',
          message: 'Select target',
          requestedSchema: {
            type: 'object',
            properties: { region: { type: 'string', enum: ['us', 'eu'] } },
            required: ['region'],
          },
        },
      });

      expect(api.elicitationRequests.value[0]).toMatchObject({
        mode: 'form',
        dialogId: 'codex-elicitation:string:elicitation-1',
        fields: [{ key: 'region', type: 'select', required: true }],
      });

      api.replyElicitationRequest('codex-elicitation:string:elicitation-1', 'accept', {
        region: 'eu',
      });

      expect(mock.adapter.respondToServerRequest).toHaveBeenCalledWith('elicitation-1', {
        action: 'accept',
        content: { region: 'eu' },
        _meta: null,
      });
      expect(api.elicitationRequests.value).toEqual([]);
    });

    it('clears pending structured requests on disconnect', async () => {
      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      mock.emitServerRequest({
        id: 'elicitation-2',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thr_existing',
          turnId: null,
          serverName: 'identity',
          mode: 'url',
          message: 'Authorize',
          url: 'https://example.test',
          elicitationId: 'external-1',
        },
      });
      expect(api.elicitationRequests.value).toHaveLength(1);

      api.disconnect();

      expect(api.permissionRequests.value).toEqual([]);
      expect(api.elicitationRequests.value).toEqual([]);
    });

    it('clears structured requests when the server resolves them', async () => {
      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      mock.emitServerRequest({
        id: 8,
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_1',
          itemId: 'permission-item',
          cwd: '/repo',
          permissions: { network: { enabled: true } },
        },
      });
      mock.emitServerRequest({
        id: 'elicitation-resolved',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_1',
          serverName: 'deployments',
          mode: 'form',
          message: 'Select target',
          requestedSchema: { type: 'object', properties: {} },
        },
      });

      mock.emit({ method: 'serverRequest/resolved', params: { requestId: 8 } });
      mock.emit({
        method: 'serverRequest/resolved',
        params: { requestId: 'elicitation-resolved' },
      });

      expect(api.permissionRequests.value).toEqual([]);
      expect(api.elicitationRequests.value).toEqual([]);
    });

    it('clears structured requests when the active turn changes', async () => {
      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      mock.emitServerRequest({
        id: 'permission-stale',
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_1',
          itemId: 'permission-item',
          cwd: '/repo',
          permissions: { network: { enabled: true } },
        },
      });
      mock.emitServerRequest({
        id: 'elicitation-stale',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_1',
          serverName: 'deployments',
          mode: 'form',
          message: 'Select target',
          requestedSchema: { type: 'object', properties: {} },
        },
      });

      mock.emit({
        method: 'turn/started',
        params: { threadId: 'thr_existing', turn: { id: 'turn_2', status: 'inProgress' } },
      });

      expect(api.permissionRequests.value).toEqual([]);
      expect(api.elicitationRequests.value).toEqual([]);
    });

    it('parses and answers current-wire tool user-input requests', async () => {
      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      mock.emitServerRequest({
        id: 'tool-input',
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_1',
          itemId: 'item-1',
          questions: [
            {
              id: 'target',
              header: 'Deployment target',
              question: 'Where should this deploy?',
              isOther: true,
              isSecret: true,
              options: [{ label: 'staging', description: 'Staging environment' }],
            },
          ],
        },
      });

      expect(api.toolUserInputRequests.value).toEqual([
        {
          requestId: 'tool-input',
          itemId: 'item-1',
          threadId: 'thr_existing',
          turnId: 'turn_1',
          questions: [
            {
              id: 'target',
              header: 'Deployment target',
              text: 'Where should this deploy?',
              isOther: true,
              isSecret: true,
              options: [{ label: 'staging', description: 'Staging environment' }],
            },
          ],
        },
      ]);

      await api.respondToToolUserInput('tool-input', [
        { questionId: 'target', response: 'staging' },
      ]);

      expect(mock.adapter.respondToServerRequest).toHaveBeenCalledWith('tool-input', {
        answers: { target: { answers: ['staging'] } },
      });
    });

    it('parses and answers current-wire dynamic tool calls', async () => {
      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      mock.emitServerRequest({
        id: 9,
        method: 'item/tool/call',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_1',
          callId: 'call-1',
          namespace: 'vis',
          tool: 'deploy',
          arguments: { target: 'staging' },
        },
      });

      expect(api.dynamicToolCalls.value).toEqual([
        {
          requestId: 9,
          callId: 'call-1',
          namespace: 'vis',
          toolName: 'deploy',
          arguments: { target: 'staging' },
          threadId: 'thr_existing',
          turnId: 'turn_1',
        },
      ]);

      await api.respondToDynamicToolCall(9, [{ type: 'inputText', text: 'deployed' }]);

      expect(mock.adapter.respondToServerRequest).toHaveBeenCalledWith(9, {
        contentItems: [{ type: 'inputText', text: 'deployed' }],
        success: true,
      });
    });
  });
});
