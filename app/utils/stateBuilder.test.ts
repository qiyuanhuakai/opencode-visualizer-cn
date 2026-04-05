import { describe, expect, it } from 'vitest';

import type { SessionInfo } from '../types/sse';
import { createStateBuilder } from './stateBuilder';

describe('createStateBuilder regression', () => {
  it('preserves pinned and archived timestamps on partial session update', () => {
    const builder = createStateBuilder();

    builder.processSessionUpdated({
      id: 's1',
      projectID: 'p1',
      title: 'Test',
      slug: 'test',
      directory: '/',
      version: '1',
      time: { created: 1, updated: 1, pinned: 1000, archived: 2000 },
    } as SessionInfo);

    builder.processSessionUpdated({
      id: 's1',
      projectID: 'p1',
      time: { updated: 2 },
    } as SessionInfo);

    const session = builder.getState().projects.p1.sandboxes['/'].sessions.s1;

    expect(session.timePinned).toBe(1000);
    expect(session.timeArchived).toBe(2000);
  });
});
