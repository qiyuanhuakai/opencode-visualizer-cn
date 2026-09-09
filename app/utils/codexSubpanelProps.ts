import { markRaw, type Ref } from 'vue';

export type CodexModeSelection = {
  readonly selectedMode: Ref<string>;
  readonly onSelectMode: (mode: string) => void;
};

export function createCodexSubpanelProps<T extends object>(
  api: T,
  onOpenFilePreview: (path: string) => void,
  modeSelection?: CodexModeSelection,
) {
  return markRaw({
    api,
    onOpenFilePreview,
    modeSelection,
  });
}
