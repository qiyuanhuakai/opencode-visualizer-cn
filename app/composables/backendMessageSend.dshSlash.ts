import { onScopeDispose, getCurrentScope, watch } from 'vue';
import { parseLeadingSlashCommand } from '../utils/codexSlashCommands';
import type { BackendMessageSendParams } from './backendMessageSend.types';

export function createDshSlashDispatcher(params: BackendMessageSendParams) {
  let controller: AbortController | undefined;
  let generation = 0;
  watch([params.activeBackendKind, params.selectedSessionId], () => {
    generation++;
    controller?.abort();
    controller = undefined;
  }, { flush: 'sync' });
  if (getCurrentScope()) onScopeDispose(() => { generation++; controller?.abort(); });
  return async (): Promise<boolean> => {
    const input = params.messageInput.value;
    const command = parseLeadingSlashCommand(input);
    if (!command || (command.name !== 'export' && (command.name !== 'feedback' || command.arguments))) return false;
    if (controller) return true;
    const sessionId = params.selectedSessionId.value;
    if (!sessionId.trim()) {
      params.setSendStatusKey('app.error.noSessionSelected');
      return true;
    }
    if (command.name === 'export' && command.arguments) return false;
    const owner = generation;
    const isCurrent = () => owner === generation && params.activeBackendKind.value === 'dsh' && params.selectedSessionId.value === sessionId;
    const current = new AbortController();
    controller = current;
    try {
      if (command.name === 'export') {
        if (!params.onDshExportSession) { params.setSendStatusKey('app.error.unavailable', { action: '/export' }); return true; }
        await params.onDshExportSession(sessionId, current.signal);
      } else {
        if (!params.onDshFeedback) { params.setSendStatusKey('app.error.unavailable', { action: '/feedback' }); return true; }
        params.onDshFeedback(sessionId);
      }
      if (isCurrent() && params.messageInput.value === input) {
        params.messageInput.value = '';
        params.persistComposerDraftForCurrentContext();
      }
    } catch (reason) {
      if (isCurrent()) params.setSendStatusKey('app.error.sendFailed', { message: params.toErrorMessage(reason) });
    } finally { if (controller === current) controller = undefined; }
    return true;
  };
}
