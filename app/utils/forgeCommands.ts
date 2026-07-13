export type ForgeInputMode = 'forge' | 'muse' | 'sage' | 'suggest' | 'commit-preview';

export type ForgeCommand = `:${string}`;

export type ForgeInputModeItem = {
  readonly action: string;
  readonly command: ForgeInputMode;
  readonly labelKey: string;
};

export type ForgeCommandItem = {
  readonly action: string;
  readonly command: ForgeCommand;
  readonly labelKey: string;
};

export type ForgeCommandGroup = {
  readonly id: string;
  readonly labelKey: string;
  readonly items: readonly ForgeCommandItem[];
};

export const FORGE_INPUT_MODES: readonly ForgeInputModeItem[] = [
  { action: 'mode-forge', command: 'forge', labelKey: 'forgePanel.shortcuts.forge' },
  { action: 'mode-muse', command: 'muse', labelKey: 'forgePanel.shortcuts.muse' },
  { action: 'mode-sage', command: 'sage', labelKey: 'forgePanel.shortcuts.sage' },
  { action: 'mode-suggest', command: 'suggest', labelKey: 'forgePanel.shortcuts.suggest' },
  { action: 'mode-commit-preview', command: 'commit-preview', labelKey: 'forgePanel.shortcuts.commitPreview' },
] as const;

export const FORGE_COMMAND_GROUPS: readonly ForgeCommandGroup[] = [
  {
    id: 'config',
    labelKey: 'forgePanel.commandGroups.config',
    items: [
      { action: 'config', command: ':config', labelKey: 'forgePanel.shortcuts.config' },
      { action: 'config-edit', command: ':config-edit', labelKey: 'forgePanel.shortcuts.configEdit' },
      { action: 'config-model', command: ':config-model', labelKey: 'forgePanel.shortcuts.configModel' },
      { action: 'config-reload', command: ':config-reload', labelKey: 'forgePanel.shortcuts.configReload' },
      { action: 'config-commit-model', command: ':config-commit-model', labelKey: 'forgePanel.shortcuts.configCommitModel' },
      { action: 'config-suggest-model', command: ':config-suggest-model', labelKey: 'forgePanel.shortcuts.configSuggestModel' },
      { action: 'config-reasoning-effort', command: ':config-reasoning-effort', labelKey: 'forgePanel.shortcuts.configReasoningEffort' },
    ],
  },
  {
    id: 'temporary',
    labelKey: 'forgePanel.commandGroups.temporary',
    items: [
      { action: 'login', command: ':login', labelKey: 'forgePanel.shortcuts.login' },
      { action: 'logout', command: ':logout', labelKey: 'forgePanel.shortcuts.logout' },
      { action: 'model', command: ':model', labelKey: 'forgePanel.shortcuts.model' },
      { action: 'reasoning-effort', command: ':reasoning-effort', labelKey: 'forgePanel.shortcuts.reasoningEffort' },
    ],
  },
  {
    id: 'workspace',
    labelKey: 'forgePanel.commandGroups.workspace',
    items: [
      { action: 'workspace-sync', command: ':workspace-sync', labelKey: 'forgePanel.shortcuts.workspaceSync' },
      { action: 'workspace-init', command: ':workspace-init', labelKey: 'forgePanel.shortcuts.workspaceInit' },
    ],
  },
  {
    id: 'conversation',
    labelKey: 'forgePanel.commandGroups.conversation',
    items: [
      { action: 'compact', command: ':compact', labelKey: 'forgePanel.shortcuts.compact' },
      { action: 'copy', command: ':copy', labelKey: 'forgePanel.shortcuts.copy' },
      { action: 'edit', command: ':edit', labelKey: 'forgePanel.shortcuts.edit' },
      { action: 'retry', command: ':retry', labelKey: 'forgePanel.shortcuts.retry' },
    ],
  },
] as const;

export const FORGE_SIDEBAR_COMMANDS: readonly ForgeCommandItem[] = [
  { action: 'conversation-new', command: ':new', labelKey: 'forgePanel.shortcuts.new' },
  { action: 'conversation-clone', command: ':clone', labelKey: 'forgePanel.shortcuts.clone' },
  { action: 'conversation-open', command: ':conversation', labelKey: 'forgePanel.shortcuts.conversation' },
  { action: 'conversation-rename', command: ':conversation-rename', labelKey: 'forgePanel.shortcuts.conversationRename' },
  { action: 'conversation-tree', command: ':conversation-tree', labelKey: 'forgePanel.shortcuts.conversationTree' },
  { action: 'conversation-delete', command: ':delete', labelKey: 'forgePanel.shortcuts.delete' },
] as const;

export const FORGE_STATUS_COMMANDS: readonly ForgeCommandItem[] = [
  { action: 'info', command: ':info', labelKey: 'forgePanel.shortcuts.info' },
  { action: 'tools', command: ':tools', labelKey: 'forgePanel.shortcuts.tools' },
  { action: 'skill', command: ':skill', labelKey: 'forgePanel.shortcuts.skill' },
  { action: 'workspace-info', command: ':workspace-info', labelKey: 'forgePanel.shortcuts.workspaceInfo' },
] as const;

export function toForgeCommandLine(command: ForgeCommand) {
  return `${command}\n`;
}

export function toForgePromptLine(mode: ForgeInputMode, value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith(':')) return `${trimmed}\n`;
  if (mode === 'forge') return `: ${trimmed}\n`;
  return `:${mode} ${trimmed}\n`;
}
