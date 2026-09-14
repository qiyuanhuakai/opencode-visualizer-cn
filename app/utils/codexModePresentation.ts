import type { CodexCollaborationMode } from '../backends/codex/codexAdapter';
import { codexCollaborationUi } from '../locales/codexCollaborationUi';
import { resolveAgentColor, type ThemeColors } from './theme';

export function codexModeOptions(modes: readonly CodexCollaborationMode[], locale: string) {
  const messages = Object.entries(codexCollaborationUi).find(([key]) => key === locale)?.[1]
    ?? codexCollaborationUi.en;
  const available = modes.length ? modes : [{ mode: 'default', name: 'Default' }];
  return available.map(mode => ({
    id: mode.mode,
    label: mode.name,
    description: mode.mode === 'default' || mode.mode === 'plan'
      ? messages[mode.mode] : messages.custom,
  }));
}

export function codexModeColor(mode: string, theme: ThemeColors): string {
  const token = mode === 'default' ? 'success' : mode === 'plan' ? 'accent' : 'secondary';
  return resolveAgentColor(mode, token, [], theme);
}
