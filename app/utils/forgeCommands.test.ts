import { describe, expect, it } from 'vitest';

import {
  FORGE_COMMAND_GROUPS,
  FORGE_SIDEBAR_COMMANDS,
  FORGE_STATUS_COMMANDS,
  toForgeCommandLine,
} from './forgeCommands';

describe('Forge command definitions', () => {
  it('defines every menu command with Forge colon syntax and sends it unchanged', () => {
    const commands = [
      ...FORGE_COMMAND_GROUPS.flatMap((group) => group.items),
      ...FORGE_SIDEBAR_COMMANDS,
      ...FORGE_STATUS_COMMANDS,
    ];

    const sentLines = commands.map((item) => toForgeCommandLine(item.command));

    expect(FORGE_COMMAND_GROUPS.length).toBeGreaterThan(0);
    expect(FORGE_COMMAND_GROUPS.every((group) => group.id.trim() && group.labelKey.trim())).toBe(true);
    expect(FORGE_COMMAND_GROUPS.every((group) => group.items.length > 0)).toBe(true);
    expect(FORGE_SIDEBAR_COMMANDS.length).toBeGreaterThan(0);
    expect(FORGE_STATUS_COMMANDS.length).toBeGreaterThan(0);
    expect(commands.length).toBeGreaterThan(0);
    expect(new Set(commands.map((item) => item.command)).size).toBe(commands.length);
    expect(
      commands.every(
        (item) => item.labelKey.trim().length > 0 && item.action.trim().length > 0,
      ),
    ).toBe(true);
    expect(commands.every((item) => item.command.startsWith(':'))).toBe(true);
    expect(FORGE_STATUS_COMMANDS.find((item) => item.action === 'skill')?.command).toBe(':skill');
    expect(sentLines.every((line) => line.startsWith(':'))).toBe(true);

    const representativeItems = [
      commands[0],
      commands[Math.floor(commands.length / 2)],
      commands[commands.length - 1],
    ];
    for (const item of representativeItems) {
      expect(toForgeCommandLine(item.command)).toBe(`${item.command}\n`);
    }
  });
});
