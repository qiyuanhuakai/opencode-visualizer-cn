import type { BackendKind } from '../backends/types';

export function defaultComposerMode(backend: BackendKind, options: readonly { readonly id: string }[]): string {
  const preferred = backend === 'codex' ? 'default' : 'build';
  return options.find((option) => option.id === preferred)?.id ?? options[0]?.id ?? preferred;
}
