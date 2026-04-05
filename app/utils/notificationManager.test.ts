import { beforeEach, describe, expect, it } from 'vitest';

import { createNotificationManager } from './notificationManager';

describe('createNotificationManager', () => {
  const resolveRoot = (_projectId: string, sessionId: string) => ({
    projectId: 'p1',
    sessionId,
  });

  let manager: ReturnType<typeof createNotificationManager>;

  beforeEach(() => {
    manager = createNotificationManager(resolveRoot);
  });

  it('adds a notification and returns true', () => {
    expect(manager.addNotification('p1', 's1', 'r1')).toBe(true);
    expect(manager.getState()).toEqual({
      s1: { projectId: 'p1', sessionId: 's1', requestIds: ['r1'] },
    });
  });

  it('returns false when adding duplicate requestId', () => {
    manager.addNotification('p1', 's1', 'r1');
    expect(manager.addNotification('p1', 's1', 'r1')).toBe(false);
  });

  it('returns false for empty inputs', () => {
    expect(manager.addNotification('', 's1', 'r1')).toBe(false);
    expect(manager.addNotification('p1', '', 'r1')).toBe(false);
    expect(manager.addNotification('p1', 's1', '')).toBe(false);
  });

  it('removes a notification by requestId', () => {
    manager.addNotification('p1', 's1', 'r1');
    manager.addNotification('p1', 's1', 'r2');
    expect(manager.removeNotification('r1')).toBe(true);
    expect(manager.getState().s1.requestIds).toEqual(['r2']);
  });

  it('removes the session entry when last requestId is removed', () => {
    manager.addNotification('p1', 's1', 'r1');
    expect(manager.removeNotification('r1')).toBe(true);
    expect(manager.getState()).toEqual({});
    expect(manager.hasAny()).toBe(false);
  });

  it('returns false when removing unknown requestId', () => {
    expect(manager.removeNotification('unknown')).toBe(false);
  });

  it('clears all notifications for a session', () => {
    manager.addNotification('p1', 's1', 'r1');
    manager.addNotification('p1', 's1', 'r2');
    expect(manager.clearSession('p1', 's1')).toBe(true);
    expect(manager.getState()).toEqual({});
  });

  it('returns false when clearing non-existent session', () => {
    expect(manager.clearSession('p1', 's1')).toBe(false);
  });

  it('maintains session insertion order', () => {
    manager.addNotification('p1', 's1', 'r1');
    manager.addNotification('p1', 's2', 'r2');
    manager.addNotification('p1', 's3', 'r3');
    expect(manager.getSessionKeys()).toEqual(['s1', 's2', 's3']);
  });

  it('removes cleared sessions from order', () => {
    manager.addNotification('p1', 's1', 'r1');
    manager.addNotification('p1', 's2', 'r2');
    manager.addNotification('p1', 's3', 'r3');
    manager.clearSession('p1', 's2');
    expect(manager.getSessionKeys()).toEqual(['s1', 's3']);
  });

  it('imports state from snapshot', () => {
    manager.importState({
      s1: { projectId: 'p1', sessionId: 's1', requestIds: ['r1', 'r2'] },
      s2: { projectId: 'p1', sessionId: 's2', requestIds: ['r3'] },
    });
    expect(manager.getState()).toEqual({
      s1: { projectId: 'p1', sessionId: 's1', requestIds: ['r1', 'r2'] },
      s2: { projectId: 'p1', sessionId: 's2', requestIds: ['r3'] },
    });
    expect(manager.getSessionKeys()).toEqual(['s1', 's2']);
    expect(manager.hasAny()).toBe(true);
  });

  it('skips invalid entries when importing state', () => {
    manager.importState({
      s1: { projectId: '', sessionId: 's1', requestIds: ['r1'] },
      s2: { projectId: 'p1', sessionId: '', requestIds: ['r2'] },
      s3: { projectId: 'p1', sessionId: 's3', requestIds: [] },
      s4: { projectId: 'p1', sessionId: 's4', requestIds: ['r4'] },
    });
    expect(Object.keys(manager.getState())).toEqual(['s4']);
  });
});
