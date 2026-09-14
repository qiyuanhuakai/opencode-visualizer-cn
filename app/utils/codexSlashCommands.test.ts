import { describe, expect, it } from 'vitest';
import {
  listCodexSlashCommands,
  parseCodexSlashCommand,
  parseLeadingSlashCommand,
} from './codexSlashCommands';

describe('Codex command registry', () => {
  it('preserves multiline command arguments', () => {
    expect(parseCodexSlashCommand(' /BtW explain this\nand that ')).toEqual({
      name: 'btw',
      arguments: 'explain this\nand that',
    });
  });
  it.each(['hello /usage', '/tmp/project', '//usage', '/usage?', '```\n/usage\n```'])(
    'keeps non-command input as text: %s',
    (input) => {
      expect(parseLeadingSlashCommand(input)).toBeNull();
    },
  );
  it('omits excluded commands from completion', () => {
    const names = listCodexSlashCommands().map(({ name }) => name);
    for (const excluded of ['mention', 'theme', 'statusline', 'keymap', 'agent', 'subagent', 'subagents'])
      expect(names).not.toContain(excluded);
    expect(new Set(names).size).toBe(names.length);
  });
});
