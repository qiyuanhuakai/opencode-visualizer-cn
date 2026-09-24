import type { KimiWebSessionProfileInput } from '../../utils/kimiWeb';
import type { KimiWebPermissionMode } from './sessionModes';

export function kimiWebComposerProfile(
  selectedModel: string,
  thinking: string | undefined,
  permission?: KimiWebPermissionMode,
): KimiWebSessionProfileInput {
  if (!selectedModel && !permission) return {};
  const separator = selectedModel.indexOf('/');
  const model = selectedModel ? separator >= 0 ? selectedModel.slice(separator + 1) : selectedModel : '';
  return { agent_config: { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(permission ? { permission_mode: permission } : {}) } };
}
