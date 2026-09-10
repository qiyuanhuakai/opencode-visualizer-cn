import { beforeEach, describe, expect, it } from 'vitest';
import { createCodexThreadActivity } from './threadActivity';

describe('Codex thread participation', () => {
  beforeEach(() => localStorage.clear());

  it('preserves observed and locally sent participation after reload, leaving untouched idle unknown', () => {
    const activity = createCodexThreadActivity();
    activity.setConnection('ws://localhost:4500/ws');
    activity.observe('observed', { type: 'active' });
    activity.observe('observed', { type: 'idle' });
    activity.observe('untouched', { type: 'idle' });
    activity.markParticipated('sent');
    activity.observe('retrying', { type: 'retry' });
    const restored = createCodexThreadActivity();
    restored.setConnection('ws://localhost:4500/ws');
    expect([...restored.participatedThreadIds.value]).toEqual(['observed', 'sent', 'retrying']);
  });

  it('isolates different endpoints and restores participation when returning', () => {
    const activity = createCodexThreadActivity();
    activity.setConnection('ws://localhost:4500/one/ws');
    activity.markParticipated('same-id');
    for (const url of ['ws://localhost:4501/one/ws', 'ws://localhost:4500/two/ws', 'ws://other:4500/one/ws']) {
      activity.setConnection(url);
      expect(activity.participatedThreadIds.value.size).toBe(0);
    }
    activity.setConnection('ws://localhost:4500/one/ws');
    expect(activity.participatedThreadIds.value.has('same-id')).toBe(true);
  });

  it('canonicalizes the connection without storing credentials', () => {
    const activity = createCodexThreadActivity();
    activity.setConnection('ws://user:secret@LOCALHOST:4500/ws?token=secret#secret');
    activity.markParticipated('thread');
    activity.setConnection('ws://localhost:4500/ws?token=replaced');
    expect(activity.participatedThreadIds.value.has('thread')).toBe(true);
    expect(Object.keys(localStorage).join(' ')).not.toContain('secret');
  });
});
