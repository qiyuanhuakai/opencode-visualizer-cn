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
});
