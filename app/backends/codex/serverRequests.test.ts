import { describe, expect, it } from 'vitest';
import {
  buildCodexPermissionResponse,
  buildMcpElicitationResponse,
  parseCodexPermissionRequest,
  parseMcpElicitationRequest,
} from './serverRequests';

describe('Codex server request parsing', () => {
  it('parses item/permissions/requestApproval with the exact requested profile', () => {
    expect(parseCodexPermissionRequest({
      id: 42,
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        environmentId: null,
        startedAtMs: 1234,
        cwd: '/repo',
        reason: 'Need package metadata',
        permissions: {
          network: { enabled: true },
          fileSystem: { read: ['/repo/package.json'], write: null },
        },
      },
    })).toEqual({
      requestId: 42,
      dialogId: 'codex-permission:number:42',
      sessionID: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      cwd: '/repo',
      reason: 'Need package metadata',
      requestedPermissions: {
        network: { enabled: true },
        fileSystem: { read: ['/repo/package.json'], write: null },
      },
    });
  });

  it('builds turn, session, and rejection permission responses', () => {
    const permissions = { network: { enabled: true } };
    expect(buildCodexPermissionResponse(permissions, 'once')).toEqual({
      permissions,
      scope: 'turn',
    });
    expect(buildCodexPermissionResponse(permissions, 'always')).toEqual({
      permissions,
      scope: 'session',
    });
    expect(buildCodexPermissionResponse(permissions, 'reject')).toEqual({
      permissions: {},
      scope: 'turn',
    });
  });

  it('parses MCP form and URL elicitations without persisting form content', () => {
    const form = parseMcpElicitationRequest({
      id: 'form-request',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'payments',
        mode: 'form',
        message: 'Choose a deployment target',
        requestedSchema: {
          type: 'object',
          properties: {
            region: { type: 'string', enum: ['us-east', 'eu-west'] },
            replicas: { type: 'number', minimum: 1, maximum: 5 },
          },
          required: ['region'],
        },
      },
    });
    expect(form).toMatchObject({
      mode: 'form',
      requestId: 'form-request',
      serverName: 'payments',
      message: 'Choose a deployment target',
      required: ['region'],
    });

    expect(parseMcpElicitationRequest({
      id: 9,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-2',
        turnId: null,
        serverName: 'identity',
        mode: 'url',
        message: 'Authorize access',
        url: 'https://example.test/authorize',
        elicitationId: 'elicitation-1',
      },
    })).toEqual({
      mode: 'url',
      requestId: 9,
      dialogId: 'codex-elicitation:number:9',
      sessionID: 'thread-2',
      turnId: null,
      serverName: 'identity',
      message: 'Authorize access',
      url: 'https://example.test/authorize',
      elicitationId: 'elicitation-1',
    });
  });

  it('builds protocol-correct MCP elicitation responses', () => {
    expect(buildMcpElicitationResponse('accept', { region: 'eu-west' })).toEqual({
      action: 'accept',
      content: { region: 'eu-west' },
      _meta: null,
    });
    expect(buildMcpElicitationResponse('decline')).toEqual({
      action: 'decline',
      content: null,
      _meta: null,
    });
    expect(buildMcpElicitationResponse('cancel')).toEqual({
      action: 'cancel',
      content: null,
      _meta: null,
    });
  });

  it('rejects MCP elicitation URLs outside HTTP and HTTPS', () => {
    const request = (url: string) => parseMcpElicitationRequest({
      id: 'unsafe-url',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'identity',
        mode: 'url',
        message: 'Authorize access',
        url,
        elicitationId: 'elicitation-1',
      },
    });

    expect(request('javascript:alert(1)')).toBeNull();
    expect(request('data:text/html,unsafe')).toBeNull();
    expect(request('file:///etc/passwd')).toBeNull();
  });
});
