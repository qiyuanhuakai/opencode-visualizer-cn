import { describe, expect, it, vi } from 'vitest';
import type { AcpClientEvent } from '../backends/acp/acpClient';
import { createAcpToolPart } from '../backends/acp/toolPart';
import { useAcpMessageBridge } from './useAcpMessageBridge';

describe('ACP replay tool reconciliation', () => {
  it('reconciles terminal replay tools without opening replay running tools', () => {
    let receive: ((event: AcpClientEvent) => void) | undefined;
    const onToolPart = vi.fn();
    const onReconcileToolPart = vi.fn();
    const bridge = useAcpMessageBridge({
      msg: { updateMessage: vi.fn(), updatePart: vi.fn() },
      upsertPermissionEntry: vi.fn(), onSessionUpdated: vi.fn(),
      onToolPart, onReconcileToolPart,
    });
    bridge.bind({ onEvent(handler) { receive = handler; return () => { receive = undefined; }; } });
    const running = createAcpToolPart('session', 'message', {
      toolCallId: 'shell', status: 'in_progress', title: 'bash',
    }, undefined, 1);
    receive?.({ type: 'message.part.updated', part: running });
    expect(onToolPart).toHaveBeenCalledOnce();
    receive?.({ type: 'message.part.updated', part: running, replay: true });
    expect(onReconcileToolPart).not.toHaveBeenCalled();
    const terminal = createAcpToolPart('session', 'message', {
      toolCallId: 'shell', status: 'completed', rawOutput: 'done',
    }, running, 2);
    receive?.({ type: 'message.part.updated', part: terminal, replay: true });
    expect(onReconcileToolPart).toHaveBeenCalledExactlyOnceWith(terminal);
    receive?.({ type: 'message.part.updated', part: terminal });
    expect(onToolPart).toHaveBeenCalledOnce();
    bridge.stop();
  });
});
