import { describe, expect, it, vi } from 'vitest';
import { createAcpAgentSelectorOptions, syncAcpPromptConfig } from './configOptions';

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
