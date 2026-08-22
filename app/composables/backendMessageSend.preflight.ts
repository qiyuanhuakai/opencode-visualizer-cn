import type { BackendMessageSendParams, SendPreflight } from './backendMessageSend.types';

function resolveSessionId(
  params: BackendMessageSendParams,
  selectedSessionId: string,
): string | null {
  if (params.filteredSessions.value.some((session) => session.id === selectedSessionId)) {
    return selectedSessionId;
  }
  const fallbackId = params.pickPreferredSessionId(params.filteredSessions.value);
  const fallback = fallbackId
    ? params.filteredSessions.value.find((session) => session.id === fallbackId)
    : params.filteredSessions.value[0];
  if (!fallback) {
    params.setSendStatusKey('app.error.noSessionSelected');
    return null;
  }
  params.selectedSessionId.value = fallback.id;
  return fallback.id;
}

function resolveOpenCodeModel(params: BackendMessageSendParams, selectedModel: string) {
  const selectedInfo = params.modelOptions.value.find((model) => model.id === selectedModel);
  const selectedModelIDs = params.parseProviderModelKey(selectedModel);
  const providerID = selectedInfo?.providerID ?? (selectedModelIDs.providerID || undefined);
  const modelID = selectedInfo?.modelID ?? (selectedModelIDs.modelID || undefined);
  return { providerID, modelID };
}

export function prepareSendPreflight(params: BackendMessageSendParams): SendPreflight | null {
  const backend = params.activeBackendKind.value;
  const text = params.messageInput.value.trim();
  const attachments = params.attachments.value.slice();
  const hasText = text.length > 0;
  const hasAttachments = attachments.length > 0;
  const transformedText = text;
  const transformText = (value: string) => value;
  if ((!hasText && !hasAttachments) || !params.selectedSessionId.value) return null;
  const sessionId = resolveSessionId(params, params.selectedSessionId.value);
  if (!sessionId) return null;
  const selectedModel = params.selectedModel.value;
  const slash = hasText ? params.parseSlashCommand(text) : null;
  const commandMatch = slash ? params.findCommandByName(slash.name) : null;
  const selectedMode = params.selectedMode.value;
  const selectedThinking = params.selectedThinking.value;
  const model =
    backend === 'codex'
      ? { providerID: undefined, modelID: undefined }
      : resolveOpenCodeModel(params, selectedModel);
  if (
    backend !== 'codex' &&
    (!model.providerID ||
      !model.modelID ||
      !params.isProviderEnabled(model.providerID) ||
      !params.isModelAvailable(selectedModel))
  ) {
    params.ensureSelectedModelAvailable();
    params.setSendStatusText('Select an enabled provider/model before sending.');
    return null;
  }
  const codexDirectory =
    backend === 'codex'
      ? params.normalizeProjectDirectoryForActiveBackend(params.activeDirectory.value.trim())
      : '';
  return {
    backend,
    sessionId,
    text,
    transformedText,
    hasText,
    attachments,
    selectedModel,
    selectedMode,
    selectedThinking,
    modelProvider: model.providerID,
    modelId: model.modelID,
    codexDirectory,
    slash,
    commandMatch,
    transformText,
  };
}
