import { describe, expect, it } from 'vitest';
import { ref } from 'vue';

import { waitForState } from './waitForState';

describe('waitForState', () => {
  it('resolves immediately when predicate is already true', async () => {
    const source = ref(5);
    const result = await waitForState(() => source.value, (v) => v === 5);
    expect(result).toBe(5);
  });

  it('resolves after the state changes to match predicate', async () => {
    const source = ref(0);
    const promise = waitForState(() => source.value, (v) => v === 10);
    source.value = 10;
    const result = await promise;
    expect(result).toBe(10);
  });

  it('rejects when timeout is reached', async () => {
    const source = ref(0);
    await expect(
      waitForState(() => source.value, (v) => v === 99, 50),
    ).rejects.toThrow('Timed out waiting for state update.');
  });

  it('uses custom timeout message', async () => {
    const source = ref(0);
    await expect(
      waitForState(() => source.value, (v) => v === 99, 50, 'custom timeout'),
    ).rejects.toThrow('custom timeout');
  });
});
