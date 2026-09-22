import { describe, expect, it, vi } from 'vitest';

import { createKimiWebClient } from '../../utils/kimiWeb';
import type { KimiWebModelObjectWire, KimiWebProviderWire } from '../../utils/kimiWeb';
import { createKimiWebAdapter } from './kimiWebAdapter';
import { mapKimiWebProvidersToProviderInfo } from './kimiWebProviderMapping';

type ManagedProviderFixture = KimiWebProviderWire & {
  readonly name?: string;
  readonly modelDetails: readonly KimiWebModelObjectWire[];
};

function provider(overrides: Partial<ManagedProviderFixture> = {}): ManagedProviderFixture {
  return {
    id: 'custom-openai',
    name: 'Custom OpenAI',
    type: 'openai',
    base_url: 'https://api.example.com/v1',
    default_model: 'custom-openai/gpt-4.1',
    has_api_key: true,
    status: 'connected',
    models: ['custom-openai/gpt-4.1'],
    modelDetails: [
      {
        model: 'gpt-4.1',
        name: 'GPT 4.1',
        max_context_size: 128_000,
        capabilities: ['tool_use'],
      },
    ],
    ...overrides,
  };
}

function mapped(overrides: Partial<ManagedProviderFixture> = {}) {
  return mapKimiWebProvidersToProviderInfo([provider(overrides)])[0];
}

describe('mapKimiWebProvidersToProviderInfo', () => {
  it('maps an unconfigured provider with no models without throwing', () => {
    const result = mapped({
      id: 'empty-provider',
      name: undefined,
      base_url: undefined,
      default_model: undefined,
      has_api_key: false,
      status: 'unconfigured',
      models: [],
      modelDetails: [],
    });

    expect(result).toEqual({
      id: 'empty-provider',
      name: 'empty-provider',
      baseUrl: undefined,
      hasApiKey: false,
      status: 'unconfigured',
      defaultModel: undefined,
      models: [],
    });
  });

  it('preserves whether an API key is configured', () => {
    expect(mapped({ has_api_key: true })?.hasApiKey).toBe(true);
  });

  it('propagates the provider connection status', () => {
    expect(mapped({ status: 'refreshing' })?.status).toBe('refreshing');
  });

  it('propagates the qualified default model', () => {
    expect(mapped({ default_model: 'custom-openai/gpt-4.1-mini' })?.defaultModel).toBe(
      'custom-openai/gpt-4.1-mini',
    );
  });

  it('propagates the provider base URL', () => {
    expect(mapped({ base_url: 'https://gateway.example.test/openai' })?.baseUrl).toBe(
      'https://gateway.example.test/openai',
    );
  });

  it('uses the human provider name and falls back to the id when absent', () => {
    expect(mapped()?.name).toBe('Custom OpenAI');
    expect(mapped({ id: 'fallback-id', name: undefined })?.name).toBe('fallback-id');
  });

  it('maps model display names, provider ids, and context sizes', () => {
    expect(mapped()?.models).toEqual([
      {
        id: 'gpt-4.1',
        name: 'GPT 4.1',
        providerID: 'custom-openai',
        maxContextSize: 128_000,
        capabilities: { attachment: false, reasoning: false, toolcall: true },
      },
    ]);
  });

  it('derives supported capabilities and ignores unknown values', () => {
    const result = mapped({
      models: [
        'custom-openai/multimodal',
        'custom-openai/reasoner',
        'custom-openai/unknown',
      ],
      modelDetails: [
        {
          model: 'multimodal',
          max_context_size: 32_000,
          capabilities: ['vision', 'tools'],
        },
        {
          model: 'reasoner',
          max_context_size: 64_000,
          capabilities: ['thinking', 'reasoning'],
        },
        {
          model: 'unknown',
          max_context_size: 8_000,
          capabilities: ['future_capability'],
        },
      ],
    });

    expect(Object.values(result?.models ?? {}).map((model) => model.capabilities)).toEqual([
      { attachment: true, reasoning: false, toolcall: true },
      { attachment: false, reasoning: true, toolcall: false },
      { attachment: false, reasoning: false, toolcall: false },
    ]);
  });

  it('strips only the matching provider prefix from qualified model ids', () => {
    const result = mapped({
      models: ['custom-openai/gpt-4.1', 'other-provider/foreign-model'],
      modelDetails: [
        { model: 'gpt-4.1', max_context_size: 128_000 },
        { model: 'other-provider/foreign-model', max_context_size: 16_000 },
      ],
    });

    expect(Object.values(result?.models ?? {}).map((model) => model.id)).toEqual([
      'gpt-4.1',
      'other-provider/foreign-model',
    ]);
  });

  it('keeps the composer listProviders path on GET /models', async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: {
            items: [
              {
                provider: 'managed:kimi-code',
                model: 'kimi-k2',
                display_name: 'Kimi K2',
                max_context_size: 131_072,
                capabilities: ['tools'],
              },
            ],
          },
          request_id: 'request-1',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = createKimiWebClient({ baseUrl: 'http://localhost:23004', fetcher });
    const adapter = createKimiWebAdapter({
      bridgeUrl: 'ws://localhost:23004/kimi-web/ws',
      client,
    });

    const result = await adapter.listProviders();

    expect(fetcher).toHaveBeenCalledWith(
      'http://localhost:23004/api/v1/models',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result).toEqual({
      all: [
        {
          id: 'managed:kimi-code',
          name: 'managed:kimi-code',
          models: {
            'kimi-k2': {
              id: 'kimi-k2',
              name: 'Kimi K2',
              providerID: 'managed:kimi-code',
              limit: { context: 131_072 },
              capabilities: { attachment: false, reasoning: false, toolcall: true },
            },
          },
        },
      ],
      connected: ['managed:kimi-code'],
    });
  });
});
