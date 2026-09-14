import { parseCodexSlashCommand, parseLeadingSlashCommand } from '../utils/codexSlashCommands';
import type { BackendMessageSendParams } from './backendMessageSend.types';

export function createCodexSlashDispatcher(params: BackendMessageSendParams) {
  let commandPending = false;
  return async function dispatch(): Promise<boolean> {
    if (params.activeBackendKind.value !== 'codex') return false;
    const input = params.messageInput.value;
    const leading = parseLeadingSlashCommand(input);
    if (!leading || leading.name === 'shell' || leading.name === 'debug') return false;
    if (commandPending) return true;
    const command = parseCodexSlashCommand(input);
    if (!command || !params.executeCodexSlashCommand) {
      params.setSendStatusText(`Unsupported Codex command: /${leading.name}`);
      return true;
    }
    const sessionId = params.selectedSessionId.value;
    const isCurrent = () => params.activeBackendKind.value === 'codex';
    const navigating = ['new', 'fork', 'archive'].includes(command.name);
    commandPending = true;
    try {
      if (navigating) {
        params.messageInput.value = '';
        params.persistComposerDraftForCurrentContext();
      }
      const result = await params.executeCodexSlashCommand(command);
      if (!isCurrent()) return true;
      if (result === 'not-handled') {
        if (
          (command.name === 'init' || command.name === 'plan') &&
          params.messageInput.value !== input
        )
          return false;
        params.setSendStatusText(`Unsupported Codex command: /${command.name}`);
        return true;
      }
      if (params.selectedSessionId.value === sessionId && params.messageInput.value === input) {
        params.messageInput.value = '';
        params.persistComposerDraftForCurrentContext();
      }
      return true;
    } catch (error) {
      if (navigating && isCurrent() && params.selectedSessionId.value === sessionId && !params.messageInput.value) {
        params.messageInput.value = input;
        params.persistComposerDraftForCurrentContext();
      }
      if (isCurrent())
        params.setSendStatusKey('app.error.sendFailed', { message: params.toErrorMessage(error) });
      return true;
    } finally {
      commandPending = false;
    }
  };
}
