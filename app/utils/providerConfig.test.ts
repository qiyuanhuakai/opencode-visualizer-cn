import { describe, expect, it } from 'vitest';

import { buildProviderDisabledPatch, normalizeProviderIds } from './providerConfig';

describe('provider config patches', () => {
  it('normalizes provider id lists', () => {
    expect(normalizeProviderIds([' openai ', '', ' anthropic '])).toEqual(['openai', 'anthropic']);
    expect(normalizeProviderIds()).toEqual([]);
  });

  it('disables a provider without writing enabled_providers', () => {
    expect(buildProviderDisabledPatch(null, 'openai', false)).toEqual({
      disabled_providers: ['openai'],
    });
  });

  it('re-enables a provider by removing it from disabled_providers only', () => {
    expect(
      buildProviderDisabledPatch(
        { enabled_providers: [], disabled_providers: ['openai', 'anthropic'] },
        'openai',
        true,
      ),
    ).toEqual({
      disabled_providers: ['anthropic'],
    });
  });

  it('preserves the disabled-provider-only patch even when an enabled whitelist exists', () => {
    expect(
      buildProviderDisabledPatch(
        { enabled_providers: ['openai'], disabled_providers: ['anthropic'] },
        'google',
        false,
      ),
    ).toEqual({
      disabled_providers: ['anthropic', 'google'],
    });
  });
});
