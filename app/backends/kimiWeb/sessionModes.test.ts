import { describe, expect, it } from 'vitest';

import {
  applyKimiWebSessionModePatch,
  isKimiWebPermissionMode,
  isTowerExperimentEnabled,
  serializeKimiWebSessionModeChange,
  type KimiWebSessionModeChange,
} from './sessionModes';

describe('kimi web session modes', () => {
  it('accepts only manual auto and yolo as permission modes', () => {
    for (const value of ['manual', 'auto', 'yolo']) {
      expect(isKimiWebPermissionMode(value)).toBe(true);
    }

    for (const value of ['plan', 'default', '', 'unknown']) {
      expect(isKimiWebPermissionMode(value)).toBe(false);
    }
  });

  it.each<[KimiWebSessionModeChange, object]>([
    [{ field: 'permissionMode', value: 'auto' }, { agent_config: { permission_mode: 'auto' } }],
    [{ field: 'planMode', value: true }, { agent_config: { plan_mode: true } }],
    [{ field: 'swarmMode', value: false }, { agent_config: { swarm_mode: false } }],
    [{ field: 'towerMode', value: true }, { agent_config: { tower_mode: true } }],
  ])('serializes exactly one changed agent_config field', (change, expected) => {
    expect(serializeKimiWebSessionModeChange(change)).toEqual(expected);
  });

  it('rejects tower enable unless experimental_flags.tower is exactly true', () => {
    expect(isTowerExperimentEnabled({ experimental_flags: { tower: true } })).toBe(true);
    expect(isTowerExperimentEnabled(undefined)).toBe(false);
    expect(isTowerExperimentEnabled({ experimental_flags: { tower: false } })).toBe(false);
    expect(isTowerExperimentEnabled({ experimental_flags: 'malformed' })).toBe(false);
    expect(isTowerExperimentEnabled({ features: [{ name: 'tower', state: 'Active' }] })).toBe(
      false,
    );
  });

  it('preserves explicit false and ignores absent fields when applying an event patch', () => {
    const current = {
      permissionMode: 'manual' as const,
      planMode: true,
      swarmMode: true,
      towerMode: false,
    };

    expect(applyKimiWebSessionModePatch(current, { swarmMode: false })).toEqual({
      permissionMode: 'manual',
      planMode: true,
      swarmMode: false,
      towerMode: false,
    });
  });
});
