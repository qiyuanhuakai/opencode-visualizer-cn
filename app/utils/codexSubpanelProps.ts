import { markRaw } from 'vue';

export function createCodexSubpanelProps<T extends object>(
  api: T,
  onOpenFilePreview: (path: string) => void,
) {
  return markRaw({
    api,
    onOpenFilePreview,
  });
}
