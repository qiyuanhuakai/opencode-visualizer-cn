import { describe, expect, it, vi } from 'vitest';
import { createKimiWebTurnPermissionStore } from './turnPermissions';

describe('Kimi Web turn permission store', () => {
  it('restores each accepted turn mode after a new store instance loads', () => {
    let saved: unknown;
    const write = vi.fn((value: unknown) => { saved = value; });
    const first = createKimiWebTurnPermissionStore(() => saved, write);
    first.record('session-a', 'user-1', 'yolo');
    first.record('session-a', 'user-2', 'manual');
    first.record('session-b', 'user-1', 'auto');

    const reloaded = createKimiWebTurnPermissionStore(() => saved, write);
    expect(reloaded.get('session-a', 'user-1')).toBe('yolo');
    expect(reloaded.get('session-a', 'user-2')).toBe('manual');
    expect(reloaded.get('session-b', 'user-1')).toBe('auto');
    expect(reloaded.get('session-b', 'user-2')).toBeUndefined();
  });

  it('ignores unsupported permissions and malformed saved data', () => {
    const write = vi.fn();
    const store = createKimiWebTurnPermissionStore(() => ({ 's:u': 'invalid' }), write);
    expect(store.get('s', 'u')).toBeUndefined();
    store.record('s', 'u', 'invalid');
    expect(write).not.toHaveBeenCalled();
  });
});
