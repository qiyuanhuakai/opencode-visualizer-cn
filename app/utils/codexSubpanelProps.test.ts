import { isReactive, reactive, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { createCodexSubpanelProps } from './codexSubpanelProps';

describe('createCodexSubpanelProps', () => {
  it('preserves composable refs when floating-window options become reactive', () => {
    const threadGoal = ref(null);
    const api = { threadGoal };
    const entry = reactive({ props: createCodexSubpanelProps(api, vi.fn()) });

    expect(isReactive(entry.props)).toBe(false);
    expect(entry.props.api.threadGoal).toBe(threadGoal);
  });
  it('keeps mode selection reactive across floating-window props', () => {
    const selectedMode = ref('default');
    const entry = reactive({ props: createCodexSubpanelProps({}, vi.fn(), { selectedMode, onSelectMode: vi.fn() }) });
    selectedMode.value = 'plan';
    expect(entry.props.modeSelection?.selectedMode.value).toBe('plan');
  });
});
