import { describe, expect, it } from 'vitest';
import { parseKimiWebSlashCommand } from './slashCommands';

describe('Kimi slash parser', () => {
  it('parses only supported control commands and validates arguments', () => {
    expect(parseKimiWebSlashCommand('/plan')).toEqual({ kind: 'toggle', field: 'planMode', value: undefined });
    expect(parseKimiWebSlashCommand('/swarm off')).toEqual({ kind: 'toggle', field: 'swarmMode', value: false });
    expect(parseKimiWebSlashCommand('/tower on')).toEqual({ kind: 'toggle', field: 'towerMode', value: true });
    expect(parseKimiWebSlashCommand('/manual')).toEqual({ kind: 'permission', mode: 'manual' });
    expect(parseKimiWebSlashCommand('/compact')).toEqual({ kind: 'compact' });
    expect(parseKimiWebSlashCommand('/help')).toEqual({ kind: 'help' });
    expect(parseKimiWebSlashCommand('ordinary prompt')).toBeNull();
    expect(() => parseKimiWebSlashCommand('/tower')).toThrow();
    expect(() => parseKimiWebSlashCommand('/swarm build something')).toThrow();
    expect(() => parseKimiWebSlashCommand('/unknown')).toThrow();
  });
});
