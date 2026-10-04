import { effectScope, nextTick, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import type { DshProjectionModelRef } from '../backends/dsh/types';
import { useDshComposerSelection } from './useDshComposerSelection';

describe('DSH composer selection restoration', () => {
  it('restores native thinking after refresh and keeps sessions isolated', async () => {
    const scope = effectScope();
    const sessionId = ref('first');
    const nativeSelection = ref<DshProjectionModelRef>();
    const apply = vi.fn();
    const models = ref<Array<{ id: string }>>([]);
    scope.run(() => useDshComposerSelection({ active: ref(true), sessionId, nativeSelection, models, readDraft: () => null, apply }));
    nativeSelection.value = { provider: 'native', model: 'one', reasoningEffort: 'high' };
    await nextTick();
    expect(apply).toHaveBeenLastCalledWith('native/one', 'high');
    models.value = [{ id: 'native/one' }];
    await nextTick();
    expect(apply).toHaveBeenLastCalledWith('native/one', 'high');
    sessionId.value = 'second';
    nativeSelection.value = undefined;
    await nextTick();
    expect(apply).toHaveBeenLastCalledWith(undefined, undefined);
    nativeSelection.value = { provider: 'native', model: 'two', reasoningEffort: 'low' };
    await nextTick();
    expect(apply).toHaveBeenLastCalledWith('native/two', 'low');
    scope.stop();
  });

  it('preserves an unsent draft including an explicit default thinking choice', async () => {
    const scope = effectScope();
    const nativeSelection = ref<DshProjectionModelRef>({ provider: 'native', model: 'one', reasoningEffort: 'high' });
    const apply = vi.fn();
    scope.run(() => useDshComposerSelection({ active: ref(true), sessionId: ref('first'), nativeSelection, models: ref([]), readDraft: () => ({ model: 'native/draft', variant: undefined }), apply }));
    expect(apply).toHaveBeenLastCalledWith('native/draft', undefined);
    nativeSelection.value = { provider: 'native', model: 'one', reasoningEffort: 'low' };
    await nextTick();
    expect(apply).toHaveBeenLastCalledWith('native/draft', undefined);
    scope.stop();
  });

  it('leaves other backends untouched', () => {
    const scope = effectScope();
    const apply = vi.fn();
    scope.run(() => useDshComposerSelection({ active: ref(false), sessionId: ref('first'), nativeSelection: ref({ provider: 'native', model: 'one' }), models: ref([]), readDraft: () => null, apply }));
    expect(apply).not.toHaveBeenCalled();
    scope.stop();
  });
});
