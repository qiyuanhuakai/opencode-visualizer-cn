import { beforeEach, describe, expect, it } from 'vitest';

import type { MessageInfo } from '../types/sse';
import { useMessages } from './useMessages';

describe('useMessages getDiffs', () => {
  beforeEach(() => {
    useMessages().reset();
  });

  it('preserves per-file patches from user message summary diffs', () => {
    const messages = useMessages();

    messages.updateMessage({
      id: 'msg-1',
      sessionID: 'session-1',
      role: 'user',
      time: { created: 1 },
      agent: 'build',
      model: { providerID: 'test', modelID: 'test-model' },
      summary: {
        diffs: [
          {
            file: 'app/components/renderers/DiffRenderer.vue',
            patch: '@@ -1,2 +1,2 @@\n-foo\n+bar',
            additions: 1,
            deletions: 1,
          },
          {
            file: 'app/composables/useMessages.ts',
            patch: '@@ -10,0 +11,1 @@\n+const value = true;',
            additions: 1,
            deletions: 0,
          },
        ],
      },
    } as MessageInfo);

    expect(messages.getDiffs('msg-1')).toEqual([
      {
        file: 'app/components/renderers/DiffRenderer.vue',
        diff: '@@ -1,2 +1,2 @@\n-foo\n+bar',
        before: undefined,
        after: undefined,
      },
      {
        file: 'app/composables/useMessages.ts',
        diff: '@@ -10,0 +11,1 @@\n+const value = true;',
        before: undefined,
        after: undefined,
      },
    ]);
  });
});
