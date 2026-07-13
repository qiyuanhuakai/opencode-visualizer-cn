import { describe, expect, it } from 'vitest';

import {
  FORGE_COMMAND_GROUPS,
  FORGE_SIDEBAR_COMMANDS,
  FORGE_STATUS_COMMANDS,
  toForgeCommandLine,
} from './forgeCommands';

describe('Forge command definitions', () => {
  it('defines every menu command with Forge colon syntax and sends it unchanged', () => {
    // Given: all commands rendered by Forge menus and the sidebar.
    const commands = [
      ...FORGE_COMMAND_GROUPS.flatMap((group) => group.items),
      ...FORGE_SIDEBAR_COMMANDS,
      ...FORGE_STATUS_COMMANDS,
    ];

    // When: the UI renders and sends each configured command.
    const sentLines = commands.map((item) => toForgeCommandLine(item.command));

    // Then: every label and PTY line retains its leading colon, including :skill.
    expect(commands.every((item) => item.command.startsWith(':'))).toBe(true);
    expect(FORGE_STATUS_COMMANDS.find((item) => item.action === 'skill')?.command).toBe(':skill');
    expect(sentLines.every((line) => line.startsWith(':'))).toBe(true);
  });
});
