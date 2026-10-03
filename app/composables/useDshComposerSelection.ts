import { watch, type Ref } from 'vue';
import type { DshProjectionModelRef } from '../backends/dsh/types';

type ComposerSelection = { readonly model?: string; readonly variant?: string };

export function useDshComposerSelection(options: {
  readonly active: Readonly<Ref<boolean>>;
  readonly sessionId: Readonly<Ref<string>>;
  readonly nativeSelection: Readonly<Ref<DshProjectionModelRef | undefined>>;
  readonly models: Readonly<Ref<readonly { readonly id: string }[]>>;
  readonly readDraft: (sessionId: string) => ComposerSelection | null;
  readonly apply: (model: string | undefined, variant: string | undefined) => void;
}) {
  watch([options.active, options.sessionId, options.nativeSelection, options.models], ([active, sessionId, native]) => {
    if (!active || !sessionId) return;
    const draft = options.readDraft(sessionId);
    const model = draft?.model ?? (native ? `${native.provider}/${native.model}` : undefined);
    options.apply(model, draft ? draft.variant : native?.reasoningEffort);
  }, { immediate: true });
}
