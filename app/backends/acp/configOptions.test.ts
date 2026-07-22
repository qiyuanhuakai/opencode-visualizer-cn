import { describe, expect, it, vi } from 'vitest';
import {
  createAcpAgentSelectorOptions,
  createAcpProviderResponse,
  createAcpUiModeState,
  syncAcpPromptConfig,
} from './configOptions';

describe('syncAcpPromptConfig', () => {
  it('does not forward a stale synthetic selection when the session does not offer it', async () => {
    // Given
    const request = vi.fn(async () => ({}));
    const values = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'provider/live-model',
        options: [{ value: 'provider/live-model', name: 'Live model' }],
      },
    ];

    // When
    await syncAcpPromptConfig('session-1', values, { model: 'default', mode: 'default' }, request);

    // Then
    expect(request).not.toHaveBeenCalled();
    expect(values[0]?.currentValue).toBe('provider/live-model');
  });

  it('continues syncing remaining options when one set_config_option request fails', async () => {
    // kimi-code rejects an idempotent mode set with "Already in plan mode"; a failed
    // config sync must not abort the prompt nor skip the remaining options.
    const calls: Array<{ configId: string; value: string }> = [];
    await syncAcpPromptConfig(
      'session-1',
      [
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'model-a', options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }] },
        { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
      ],
      { model: 'model-b', mode: 'plan' },
      async (params) => {
        calls.push({ configId: String(params.configId), value: String(params.value) });
        if (params.configId === 'mode') throw new Error('Already in plan mode');
        return {};
      },
    );
    expect(calls).toEqual([
      { configId: 'model', value: 'model-b' },
      { configId: 'mode', value: 'plan' },
    ]);
  });

});

describe('createAcpAgentSelectorOptions', () => {
  it('maps ACP-provided default and plan agents into selector options', () => {
    const options = createAcpAgentSelectorOptions([
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'plan',
        options: [
          { value: 'normal', name: 'Default agent', description: 'Normal workflow' },
          { value: 'acceptEdits', name: 'Accept edits' },
          { value: 'bypassPermissions', name: 'Bypass permissions' },
          { value: 'plan', name: 'Plan agent', description: 'Planning workflow' },
          { value: 'review', name: 'Review agent', description: 'Review workflow' },
        ],
      },
    ], 'ACP');

    expect(options).toEqual([
      { id: 'default', label: 'Default agent', description: 'Normal workflow' },
      { id: 'plan', label: 'Plan agent', description: 'Planning workflow' },
      { id: 'review', label: 'Review agent', description: 'Review workflow' },
    ]);
  });
});

describe('createAcpUiModeState', () => {
  const modeSelect = {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'plan', name: 'Plan' },
    ],
  };

  it('prefers a locally persisted agent over the server currentValue when valid', () => {
    const state = createAcpUiModeState([modeSelect], 'normal', 'plan');
    expect(state.agent).toBe('plan');
  });

  it('falls back to the server currentValue when the persisted agent is not offered', () => {
    const state = createAcpUiModeState([modeSelect], 'normal', 'nonexistent');
    expect(state.agent).toBe('default');
  });

  it('uses the server currentValue when no persisted agent is provided', () => {
    const mode = { ...modeSelect, currentValue: 'plan' };
    const state = createAcpUiModeState([mode], 'normal');
    expect(state.agent).toBe('plan');
  });
});

describe('createAcpProviderResponse', () => {
  it('exposes thought_level select options as model variants', () => {
    // Real OMP 17.0.2 wire shape: a 'thinking' select with category 'thought_level'.
    const response = createAcpProviderResponse([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'step-plan/step-3.5-flash',
        options: [{ value: 'step-plan/step-3.5-flash', name: 'step-3.5-flash' }],
      },
      {
        id: 'thinking',
        name: 'Thinking',
        category: 'thought_level',
        type: 'select',
        currentValue: 'off',
        options: [
          { value: 'off', name: 'Off' },
          { value: 'auto', name: 'Auto', description: 'Auto-detect per prompt' },
          { value: 'high', name: 'High' },
        ],
      },
    ], 'Oh My Pi');
    const model = response.all[0]?.models['step-plan/step-3.5-flash'];
    expect(model).toBeDefined();
    expect(model?.variants).toEqual({
      off: { name: 'Off' },
      auto: { name: 'Auto', description: 'Auto-detect per prompt' },
      high: { name: 'High' },
    });
  });

  it('omits variants when the agent offers no thought_level select', () => {
    const response = createAcpProviderResponse([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'provider/live-model',
        options: [{ value: 'provider/live-model', name: 'Live model' }],
      },
    ], 'ACP');
    expect(response.all[0]?.models['provider/live-model']?.variants).toBeUndefined();
  });
});

