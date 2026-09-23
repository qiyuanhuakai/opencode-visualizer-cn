import type { KimiWebSessionProfileInput } from '../../utils/kimiWeb';

export function kimiWebComposerProfile(
  selectedModel: string,
  thinking: string | undefined,
): KimiWebSessionProfileInput {
  if (!selectedModel) return {};
  const separator = selectedModel.indexOf('/');
  const model = separator >= 0 ? selectedModel.slice(separator + 1) : selectedModel;
  return { agent_config: { model, ...(thinking ? { thinking } : {}) } };
}
