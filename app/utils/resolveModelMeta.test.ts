import { describe, expect, it } from 'vitest';
import { resolveModelMetaForPath, type ModelOption } from './resolveModelMeta';

const sampleOptions: ModelOption[] = [
  {
    id: 'openai/gpt-4o',
    modelID: 'gpt-4o',
    label: 'OpenAI · GPT-4o',
    displayName: 'GPT-4o',
    providerID: 'openai',
    providerLabel: 'OpenAI',
  },
  {
    id: 'anthropic/claude-sonnet-4',
    modelID: 'claude-sonnet-4',
    label: 'Anthropic · Claude Sonnet 4',
    displayName: 'Claude Sonnet 4',
    providerID: 'anthropic',
    providerLabel: 'Anthropic',
  },
];

describe('resolveModelMetaForPath', () => {
  it('returns undefined when modelPath is missing', () => {
    expect(resolveModelMetaForPath(undefined, sampleOptions)).toBeUndefined();
  });

  it('returns the matched model displayName and providerLabel', () => {
    expect(resolveModelMetaForPath('openai/gpt-4o', sampleOptions)).toEqual({
      displayName: 'GPT-4o',
      providerLabel: 'OpenAI',
    });
  });

  it('falls back to the last path segment when modelPath is not in options', () => {
    expect(resolveModelMetaForPath('codex/gpt-4', sampleOptions)).toEqual({
      displayName: 'gpt-4',
    });
  });

  it('falls back to the full path when there is no slash', () => {
    expect(resolveModelMetaForPath('gpt-4', sampleOptions)).toEqual({
      displayName: 'gpt-4',
    });
  });

  it('falls back to the full path when the path ends with a slash', () => {
    expect(resolveModelMetaForPath('codex/', sampleOptions)).toEqual({
      displayName: 'codex/',
    });
  });

  it('trims whitespace from the fallback segment', () => {
    expect(resolveModelMetaForPath('codex/  gpt-4  ', sampleOptions)).toEqual({
      displayName: 'gpt-4',
    });
  });
});
