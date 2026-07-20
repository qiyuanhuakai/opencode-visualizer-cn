import { describe, expect, it, vi } from 'vitest';

import { syncAcpMessageBridge, useAcpMessageBridge } from './useAcpMessageBridge';
import type { AcpClientEvent } from '../backends/acp/acpClient';

describe('useAcpMessageBridge', () => {
  it('routes ACP adapter events into the shared message and permission stores', () => {
    let handler: ((event: AcpClientEvent) => void) | undefined;
    const adapter = {
      onEvent: vi.fn((next: (event: AcpClientEvent) => void) => {
        handler = next;
        return () => {
          handler = undefined;
        };
      }),
    };
    const msg = { updateMessage: vi.fn(), updatePart: vi.fn() };
    const upsertPermissionEntry = vi.fn();
    const onSessionUpdated = vi.fn();
    const onCommandsUpdated = vi.fn();
    const onConfigUpdated = vi.fn();
    const bridge = useAcpMessageBridge({
      msg,
      upsertPermissionEntry,
      onSessionUpdated,
      onCommandsUpdated,
      onConfigUpdated,
    });

    bridge.bind(adapter);
    const info = {
      id: 'user-1',
      sessionID: 'session-1',
      role: 'user' as const,
      time: { created: 1 },
      agent: 'default',
      model: { providerID: 'acp', modelID: 'default' },
    };
    const part = {
      id: 'part-1',
      sessionID: 'session-1',
      messageID: 'user-1',
      type: 'text' as const,
      text: 'hello',
    };
    const permission = {
      id: '7',
      sessionID: 'session-1',
      permission: 'Run tests',
      patterns: [],
      metadata: {},
      always: [],
      tool: { messageID: 'assistant-1', callID: 'tool-1' },
    };
    const session = { id: 'session-1', title: 'ACP session' };
    handler?.({ type: 'message.updated', info });
    handler?.({ type: 'message.part.updated', part });
    handler?.({ type: 'permission.asked', request: permission });
    handler?.({ type: 'session.updated', info: session });
    handler?.({ type: 'commands.updated', commands: [{ name: 'plan' }] });
    handler?.({ type: 'config.updated', options: [{ id: 'mode' }] });

    expect(msg.updateMessage).toHaveBeenCalledWith(info);
    expect(msg.updatePart).toHaveBeenCalledWith(part);
    expect(upsertPermissionEntry).toHaveBeenCalledWith(permission);
    expect(onSessionUpdated).toHaveBeenCalledWith(session);
    expect(onCommandsUpdated).toHaveBeenCalledWith([{ name: 'plan' }]);
    expect(onConfigUpdated).toHaveBeenCalledWith([{ id: 'mode' }]);
    bridge.stop();
    expect(handler).toBeUndefined();
  });

  it('stops the ACP subscription when another backend becomes active', () => {
    const source = { onEvent: vi.fn(() => vi.fn()) };
    const bridge = { bind: vi.fn(), stop: vi.fn() };

    syncAcpMessageBridge(bridge, 'acp', source);
    syncAcpMessageBridge(bridge, 'opencode');

    expect(bridge.bind).toHaveBeenCalledWith(source);
    expect(bridge.stop).toHaveBeenCalledOnce();
  });
});
