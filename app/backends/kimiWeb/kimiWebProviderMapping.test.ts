import { describe, expect, it } from 'vitest';

import type { KimiWebProviderWire } from '../../utils/kimiWeb';
import { mapKimiWebProvidersToProviderInfo } from './kimiWebProviderMapping';

describe('mapKimiWebProvidersToProviderInfo', () => {
  it('lists providers and maps the wire shape', () => {
    const providers: KimiWebProviderWire[] = [
      {
        id: 'custom-openai',
        type: 'openai',
        base_url: 'https://api.example.com/v1',
        has_api_key: true,
        status: 'connected',
        models: ['custom-openai/gpt-4.1'],
      },
      {
        id: 'empty-provider',
        type: 'anthropic',
        has_api_key: false,
        status: 'unconfigured',
        models: [],
      },
    ];

    expect(mapKimiWebProvidersToProviderInfo(providers)).toEqual([
      {
        id: 'custom-openai',
        name: 'custom-openai',
        models: {
          'gpt-4.1': {
            id: 'gpt-4.1',
            name: 'gpt-4.1',
            providerID: 'custom-openai',
            capabilities: { attachment: false, reasoning: false, toolcall: true },
          },
        },
      },
      { id: 'empty-provider', name: 'empty-provider', models: {} },
    ]);
  });
});
