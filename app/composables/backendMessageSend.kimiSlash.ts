import { watch } from 'vue';
import { parseKimiWebSlashCommand } from '../backends/kimiWeb/slashCommands';
import type { BackendMessageSendParams } from './backendMessageSend.types';

export function createKimiWebSlashDispatcher(params: BackendMessageSendParams) {
  let pending = false;
  let generation = 0;
  watch([params.activeBackendKind, params.selectedSessionId], () => { generation += 1; }, { flush: 'sync' });
  return async (): Promise<boolean> => {
    const input = params.messageInput.value;
    if (!input.trim().startsWith('/')) return false;
    const local = params.parseSlashCommand(input)?.name.toLowerCase();
    if (local === 'shell' || local === 'debug') return false;
    if (pending) return true;
    const sessionId = params.selectedSessionId.value;
    const owner = generation;
    const isCurrent = () => generation === owner && params.activeBackendKind.value === 'kimi-web' && params.selectedSessionId.value === sessionId;
    pending = true;
    try {
      const action = parseKimiWebSlashCommand(input);
      if (!action) return false;
      if (!params.executeKimiWebSlashCommand) {
        params.setSendStatusKey('app.error.unavailable', { action: 'Kimi Web command' });
        return true;
      }
      await params.executeKimiWebSlashCommand(action);
      if (isCurrent() && params.messageInput.value === input) {
        params.messageInput.value = '';
        params.persistComposerDraftForCurrentContext();
      }
    } catch (error) {
      if (isCurrent()) params.setSendStatusKey('app.error.sendFailed', { message: params.toErrorMessage(error) });
    } finally {
      pending = false;
    }
    return true;
  };
}
