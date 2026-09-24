import { describe, expect, it } from 'vitest';
import { parseKimiWebSlashCommand } from './slashCommands';

describe('Kimi slash parser', () => {
  it('parses only supported control commands and validates arguments', () => {
    expect(parseKimiWebSlashCommand('/plan')).toEqual({ kind: 'toggle', field: 'planMode', value: undefined });
    expect(parseKimiWebSlashCommand('/swarm off')).toEqual({ kind: 'toggle', field: 'swarmMode', value: false });
    expect(parseKimiWebSlashCommand('/tower on')).toEqual({ kind: 'toggle', field: 'towerMode', value: true });
    expect(parseKimiWebSlashCommand('/manual')).toEqual({ kind: 'permission', mode: 'manual' });
    expect(parseKimiWebSlashCommand('/compact')).toEqual({ kind: 'compact' });
    expect(parseKimiWebSlashCommand('/copyall')).toEqual({ kind: 'copyall' });
    expect(parseKimiWebSlashCommand('/new')).toEqual({ kind: 'new' });
    expect(parseKimiWebSlashCommand('/clear')).toEqual({ kind: 'clear' });
    expect(parseKimiWebSlashCommand('/btw What is 2 + 2?')).toEqual({ kind: 'btw', prompt: 'What is 2 + 2?' });
    expect(parseKimiWebSlashCommand('/fork')).toEqual({ kind: 'fork' });
    expect(parseKimiWebSlashCommand('/undo')).toEqual({ kind: 'undo' });
    expect(parseKimiWebSlashCommand('/status')).toEqual({ kind: 'status' });
    expect(parseKimiWebSlashCommand('/subagent')).toEqual({ kind: 'subagent' });
    expect(parseKimiWebSlashCommand('/help')).toEqual({ kind: 'help' });
    expect(parseKimiWebSlashCommand('ordinary prompt')).toBeNull();
    expect(() => parseKimiWebSlashCommand('/tower')).toThrow();
    expect(() => parseKimiWebSlashCommand('/swarm build something')).toThrow();
    expect(parseKimiWebSlashCommand('/btw')).toEqual({ kind: 'btw' });
    expect(() => parseKimiWebSlashCommand('/copyall unrelated')).toThrow();
    expect(() => parseKimiWebSlashCommand('/unknown')).toThrow();
  });
});
