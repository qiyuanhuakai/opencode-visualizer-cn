import { computed, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import type { useFloatingWindows } from './useFloatingWindows';
import { useDialogHandler } from './useDialogHandler';

describe('useDialogHandler', () => {
  it('clears every dialog of its kind without touching other windows', () => {
    const entries = ref([
      { key: 'permission:open-code' },
      { key: 'permission:codex' },
      { key: 'question:keep' },
    ]);
    const closeAll = vi.fn(({ exclude }: { exclude: (key: string) => boolean }) => {
      entries.value = entries.value.filter((entry) => exclude(entry.key));
    });
    const fw = { entries, closeAll } as unknown as ReturnType<typeof useFloatingWindows>;
    const dialog = useDialogHandler({
      fw,
      allowedSessionIds: computed(() => new Set(['session-1'])),
      kind: 'permission',
    });

    dialog.clearAll();

    expect(entries.value.map((entry) => entry.key)).toEqual(['question:keep']);
    expect(closeAll).toHaveBeenCalledTimes(1);
  });
});
