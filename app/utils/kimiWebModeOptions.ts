import {
  KIMI_WEB_PERMISSION_MODES,
  type KimiWebPermissionMode,
} from '../backends/kimiWeb/sessionModes';

export type KimiWebAgentModeOption = {
  readonly id: KimiWebPermissionMode;
  readonly labelKey: string;
  readonly descriptionKey: string;
};

/** i18n keys for the agent-mode dropdown; the wire ids themselves are never translated. */
const KIMI_WEB_AGENT_MODE_KEYS: Readonly<
  Record<KimiWebPermissionMode, { readonly label: string; readonly description: string }>
> = {
  manual: {
    label: 'kimiWeb.composer.manual',
    description: 'kimiWeb.composer.manualDescription',
  },
  auto: {
    label: 'kimiWeb.composer.auto',
    description: 'kimiWeb.composer.autoDescription',
  },
  yolo: {
    label: 'kimiWeb.composer.yolo',
    description: 'kimiWeb.composer.yoloDescription',
  },
};

export function kimiWebAgentModeOptions(): readonly KimiWebAgentModeOption[] {
  return KIMI_WEB_PERMISSION_MODES.map((id) => ({
    id,
    labelKey: KIMI_WEB_AGENT_MODE_KEYS[id].label,
    descriptionKey: KIMI_WEB_AGENT_MODE_KEYS[id].description,
  }));
}
