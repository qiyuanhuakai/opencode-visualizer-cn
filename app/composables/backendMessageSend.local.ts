import type {
  BackendMessageSendParams,
  LocalSlashResult,
  ParsedSlashCommand,
  RequestGuard,
} from './backendMessageSend.types';

export async function runLocalSlashCommand(
  params: BackendMessageSendParams,
  slash: ParsedSlashCommand | null,
  transformText: (value: string) => string,
  guard: RequestGuard,
): Promise<LocalSlashResult> {
  if (!slash) return 'not-handled';
  if (slash.name.toLowerCase() === 'shell') {
    if (!guard.isCurrent()) return 'stale';
    const ready = await params.openShellFromInput(transformText(slash.arguments));
    if (!guard.isCurrent()) return 'stale';
    if (ready) {
      params.setSendStatusKey('app.status.shellReady');
      params.clearComposerDraftForCurrentContext();
    }
    return 'handled';
  }
  if (slash.name.toLowerCase() === 'debug') {
    if (!guard.isCurrent()) return 'stale';
    const result = params.runDebugCommand(transformText(slash.arguments));
    if (!guard.isCurrent()) return 'stale';
    params.setSendStatusText(result.message);
    params.clearComposerDraftForCurrentContext();
    return 'handled';
  }
  return 'not-handled';
}
