import type { CodexTurnInputItem } from '../backends/codex/codexAdapter';
import type {
  BackendMessageSendParams,
  RequestGuard,
  SendPreflight,
} from './backendMessageSend.types';

type CodexInputResult =
  | { readonly kind: 'ready'; readonly input: CodexTurnInputItem[]; readonly prompt: string }
  | { readonly kind: 'unsupported-attachment' };

export type CodexExecutionResult =
  | { readonly kind: 'stale' }
  | { readonly kind: 'unsupported-attachment' }
  | {
      readonly kind: 'sent';
      readonly activeThreadId: string;
      readonly startNewThread: boolean;
    };

function buildCodexInput(
  params: BackendMessageSendParams,
  preflight: SendPreflight,
): CodexInputResult {
  const atAgent = preflight.hasText ? params.parseAtAgent(preflight.text) : null;
  const messageText = preflight.transformText(atAgent ? atAgent.text : preflight.text);
  const input: CodexTurnInputItem[] = [];
  if (preflight.hasText) {
    const skills = params.parseSkill?.(preflight.text, params.availableSkills?.value ?? []) ?? [];
    for (const skill of skills) input.push({ type: 'skill', name: skill.name, path: skill.path });
  }
  if (messageText) input.push({ type: 'text', text: messageText });
  for (const item of preflight.attachments) {
    if (item.lineComment) {
      input.push({
        type: 'text',
        text: params.formatCommentNote(
          item.lineComment.path,
          item.lineComment.startLine,
          item.lineComment.endLine,
          item.lineComment.text,
        ),
      });
      continue;
    }
    if (!item.mime.startsWith('image/')) return { kind: 'unsupported-attachment' };
    input.push({ type: 'image', url: item.dataUrl });
  }
  const prompt = input
    .filter((item): item is Extract<CodexTurnInputItem, { type: 'text' }> => item.type === 'text')
    .map((item) => item.text)
    .join('\n\n');
  return { kind: 'ready', input, prompt };
}

function resolveCodexSelection(params: BackendMessageSendParams, preflight: SendPreflight) {
  const selectedInfo = params.modelOptions.value.find(
    (model) => model.id === preflight.selectedModel,
  );
  const selectedModelIDs = selectedInfo
    ? {
        providerID: selectedInfo.providerID?.trim() ?? '',
        modelID: selectedInfo.modelID.trim(),
      }
    : params.parseProviderModelKey(preflight.selectedModel);
  const selectedCodexModelKey = selectedInfo?.id || preflight.selectedModel.trim();
  const selectedCodexModel =
    selectedModelIDs.modelID ||
    (!selectedCodexModelKey.includes('/') ? selectedCodexModelKey : undefined);
  const selectedCodexProvider =
    selectedModelIDs.providerID || (selectedCodexModel ? params.codexProjectId : '');
  const collaborationMode =
    selectedCodexModel &&
    params.codexApi.collaborationModes.value.some((mode) => mode.mode === preflight.selectedMode)
      ? {
          mode: preflight.selectedMode,
          settings: {
            model: selectedCodexModel,
            developer_instructions: null,
          },
        }
      : undefined;
  return {
    selectedCodexModelKey,
    selectedCodexModel,
    selectedCodexProvider,
    collaborationMode,
  };
}

type CodexSelection = ReturnType<typeof resolveCodexSelection>;

async function synchronizeCodexProvider(options: {
  readonly params: BackendMessageSendParams;
  readonly selection: CodexSelection;
  readonly guard: RequestGuard;
  readonly commitProviderConfig: (providerConfig: Record<string, unknown> | null) => void;
}): Promise<'ready' | 'stale'> {
  const { params, selection, guard, commitProviderConfig } = options;
  if (!selection.selectedCodexProvider || !selection.selectedCodexModel) return 'ready';
  if (!guard.isCurrent()) return 'stale';
  const providerConfig = await params.syncCodexActiveProviderModel(
    selection.selectedCodexProvider,
    selection.selectedCodexModel,
  );
  if (!guard.isCurrent()) return 'stale';
  commitProviderConfig(providerConfig);
  return guard.isCurrent() ? 'ready' : 'stale';
}

export async function runCodexSend(
  params: BackendMessageSendParams,
  preflight: SendPreflight,
  guard: RequestGuard,
  commitProviderConfig: (providerConfig: Record<string, unknown> | null) => void,
): Promise<CodexExecutionResult> {
  const inputResult = buildCodexInput(params, preflight);
  if (inputResult.kind === 'unsupported-attachment') return inputResult;
  const selection = resolveCodexSelection(params, preflight);
  const startNewThread = selection.selectedCodexProvider
    ? params.shouldStartNewCodexThreadForProvider(
        preflight.sessionId,
        selection.selectedCodexProvider,
      )
    : false;
  const syncResult = await synchronizeCodexProvider({
    params,
    selection,
    guard,
    commitProviderConfig,
  });
  if (syncResult === 'stale') return { kind: 'stale' };
  if (!guard.isCurrent()) return { kind: 'stale' };
  if (selection.selectedCodexModelKey) params.codexApi.selectModel(selection.selectedCodexModelKey);
  if (!guard.isCurrent()) return { kind: 'stale' };
  await params.codexApi.sendPrompt(inputResult.prompt, {
    threadId: startNewThread ? undefined : preflight.sessionId,
    forceNewThread: startNewThread,
    cwd: preflight.codexDirectory,
    model: selection.selectedCodexModel,
    effort: preflight.selectedThinking,
    collaborationMode: selection.collaborationMode,
    input: inputResult.input,
  });
  if (!guard.isCurrent()) return { kind: 'stale' };
  await params.codexApi.refreshThreads();
  if (!guard.isCurrent()) return { kind: 'stale' };
  return {
    kind: 'sent',
    activeThreadId: params.codexApi.activeThreadId.value,
    startNewThread,
  };
}
