import { describe, expect, it } from 'vitest';
import { preferredProviderModel, restoredReasoningEffort } from './providerSelection';

const models = [
  { id: 'codex/codex-auto-review', providerID: 'codex', modelID: 'codex-auto-review' },
  { id: 'codex/gpt-6-astra', providerID: 'codex', modelID: 'gpt-6-astra' },
];

describe('composer provider selection restoration', () => {
  it('falls back to the configured default instead of the first alphabetic model', () => {
    expect(preferredProviderModel(models, { codex: 'gpt-6-astra' })).toBe('codex/gpt-6-astra');
    expect(preferredProviderModel(models.slice(0, 1), { codex: 'gpt-6-astra' })).toBe('codex/codex-auto-review');
  });
  it('uses configured effort on initial login while preserving a supported prior choice', () => {
    const options = { available: [undefined, 'low', 'medium', 'high'], current: undefined, configured: 'medium', hasSavedSelection: false };
    expect(restoredReasoningEffort(options)).toBe('medium');
    expect(restoredReasoningEffort({ ...options, current: 'high' })).toBe('high');
    expect(restoredReasoningEffort({ ...options, hasSavedSelection: true })).toBeUndefined();
    expect(restoredReasoningEffort({ ...options, current: 'unsupported' })).toBe('medium');
    expect(restoredReasoningEffort({ ...options, available: [undefined] })).toBeUndefined();
  });
});
