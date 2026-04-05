import { describe, expect, it } from 'vitest';

import {
  extractStepFinish,
  extractXmlTagContent,
} from './toolRenderers';

describe('extractXmlTagContent', () => {
  it('extracts content between tags', () => {
    expect(extractXmlTagContent('hello <foo>world</foo> bye', 'foo')).toBe('world');
  });

  it('trims extracted content', () => {
    expect(extractXmlTagContent('<foo>  spaced  </foo>', 'foo')).toBe('spaced');
  });

  it('returns null when open tag is missing', () => {
    expect(extractXmlTagContent('no tags here', 'foo')).toBeNull();
  });

  it('returns null when close tag is missing', () => {
    expect(extractXmlTagContent('<foo>incomplete', 'foo')).toBeNull();
  });

  it('returns null when close tag appears before open tag', () => {
    expect(extractXmlTagContent('</foo><foo> reversed', 'foo')).toBeNull();
  });
});

describe('extractStepFinish', () => {
  const helpers = {
    MESSAGE_EVENT_TYPES: new Set(['message.part.delta']),
  };

  it('returns null for non-object payload', () => {
    expect(extractStepFinish(null, 'message.part.delta', helpers)).toBeNull();
    expect(extractStepFinish('string', 'message.part.delta', helpers)).toBeNull();
  });

  it('returns null when event type is not in MESSAGE_EVENT_TYPES', () => {
    expect(extractStepFinish({}, 'other.event', helpers)).toBeNull();
  });

  it('extracts step-finish data from payload', () => {
    const payload = {
      payload: {
        properties: {
          part: {
            type: 'step-finish',
            reason: 'done',
            sessionID: 's1',
            messageID: 'm1',
          },
        },
      },
    };
    expect(extractStepFinish(payload, 'message.part.delta', helpers)).toEqual({
      reason: 'done',
      sessionId: 's1',
      messageId: 'm1',
    });
  });

  it('falls back to record.properties when nested payload is absent', () => {
    const payload = {
      properties: {
        part: {
          type: 'step-finish',
          reason: 'aborted',
          sessionID: 's2',
          messageID: 'm2',
        },
      },
    };
    expect(extractStepFinish(payload, 'message.part.delta', helpers)).toEqual({
      reason: 'aborted',
      sessionId: 's2',
      messageId: 'm2',
    });
  });

  it('returns null when part type is not step-finish', () => {
    const payload = {
      properties: {
        part: { type: 'other' },
      },
    };
    expect(extractStepFinish(payload, 'message.part.delta', helpers)).toBeNull();
  });
});
