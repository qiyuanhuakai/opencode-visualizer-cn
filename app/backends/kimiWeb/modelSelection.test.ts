import { describe, expect, it } from 'vitest';
import { kimiWebComposerProfile } from './modelSelection';

describe('kimiWebComposerProfile', () => {
  it('creates a profile using the wire alias and selected effort', () => {
    expect(kimiWebComposerProfile('managed:kimi-code/kimi-code/kimi-for-coding-highspeed', 'high')).toEqual({
      agent_config: { model: 'kimi-code/kimi-for-coding-highspeed', thinking: 'high' },
    });
  });
  it('does not write an empty model when the model list has not loaded', () => {
    expect(kimiWebComposerProfile('', undefined)).toEqual({});
  });
  it('includes the selected permission even before the model list loads', () => {
    expect(kimiWebComposerProfile('', undefined, 'auto')).toEqual({
      agent_config: { permission_mode: 'auto' },
    });
  });
});
