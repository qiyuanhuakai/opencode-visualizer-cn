import { describe, expect, it } from 'vitest';
import {
  buildModelMetaIndex,
  resolveModelMetaForPath,
  type ModelOption,
} from './resolveModelMeta';

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
const sampleIndex = buildModelMetaIndex(sampleOptions);

describe('resolveModelMetaForPath', () => {
  it('returns undefined when modelPath is missing', () => {
    expect(resolveModelMetaForPath(undefined, sampleIndex)).toBeUndefined();
  });

  it('returns the matched model displayName and providerLabel', () => {
    expect(resolveModelMetaForPath('openai/gpt-4o', sampleIndex)).toEqual({
      displayName: 'GPT-4o',
      providerLabel: 'OpenAI',
    });
  });

  it('falls back to the last path segment when modelPath is not in options', () => {
    expect(resolveModelMetaForPath('codex/gpt-4', sampleIndex)).toEqual({
      displayName: 'gpt-4',
    });
  });

  it('falls back to the full path when there is no slash', () => {
    expect(resolveModelMetaForPath('gpt-4', sampleIndex)).toEqual({
      displayName: 'gpt-4',
    });
  });

  it('falls back to the full path when the path ends with a slash', () => {
    expect(resolveModelMetaForPath('codex/', sampleIndex)).toEqual({
      displayName: 'codex/',
    });
  });

  it('trims whitespace from the fallback segment', () => {
    expect(resolveModelMetaForPath('codex/  gpt-4  ', sampleIndex)).toEqual({
      displayName: 'gpt-4',
    });
  });

  it('does not traverse model options after building the lookup index', () => {
    let idReads = 0;
    const options = Array.from({ length: 6_227 }, (_, index): ModelOption => ({
      get id() {
        idReads += 1;
        return `provider/model-${index}`;
      },
      modelID: `model-${index}`,
      label: `Model ${index}`,
      displayName: `Model ${index}`,
      providerID: 'provider',
      providerLabel: 'Provider',
    }));
    const index = buildModelMetaIndex(options);
    const readsAfterIndexing = idReads;

    for (let lookup = 0; lookup < 100; lookup += 1) {
      expect(resolveModelMetaForPath('provider/model-4149', index)?.displayName).toBe(
        'Model 4149',
      );
      expect(resolveModelMetaForPath(`missing/model-${lookup}`, index)?.displayName).toBe(
        `model-${lookup}`,
      );
    }

    expect(idReads).toBe(readsAfterIndexing);
  });
});
