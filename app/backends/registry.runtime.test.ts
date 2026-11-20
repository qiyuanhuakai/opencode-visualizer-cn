import { describe, expect, it } from 'vitest';
import { getBackendAdapter, getRuntimeBackendCapabilities } from './registry';

describe('Bridge-owned session capability lookup', () => {
  it.each(['acp', 'kimi-web', 'dsh'] as const)('provides %s UI policy without configuring a legacy adapter', (kind) => {
    expect(() => getBackendAdapter(kind)).toThrow('Backend adapter is not registered');
    expect(getRuntimeBackendCapabilities(kind).sessions).toBe(true);
    expect(() => getBackendAdapter(kind)).toThrow('Backend adapter is not registered');
  });
});
