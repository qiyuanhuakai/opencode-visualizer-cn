import { describe, expect, it, vi } from 'vitest';

import {
  parseForgeConversationList,
  parseForgeInfo,
  useForgeAuxiliary,
  type ForgeAuxiliaryCommandRunner,
} from './useForgeAuxiliary';

type CommandCall = {
  readonly command: string;
  readonly args: readonly string[];
};

function createCommandRunner(outputs: readonly string[]) {
  const calls: CommandCall[] = [];
  const runCommand: ForgeAuxiliaryCommandRunner = vi.fn(async (command, args) => {
    calls.push({ command, args });
    const next = outputs[calls.length - 1];
    if (next === undefined) {
      throw new Error(`Missing output for command ${command} ${args.join(' ')}`);
    }
    return next;
  });
  return { calls, runCommand };
}

describe('parseForgeConversationList', () => {
  it('parses Forge porcelain conversation tables', () => {
    // Given: Forge prints a fixed-column porcelain table.
    const output = [
      'ID                                    TITLE             UPDATED',
      '785620ee-b9f6-4338-8cda-5ccaacce6be4  Repository setup  9m ago',
      '11111111-2222-3333-4444-555555555555  [empty]           1h ago',
    ].join('\n');

    // When: the output crosses the frontend boundary.
    const conversations = parseForgeConversationList(output);

    // Then: the table becomes typed conversation metadata for the sidebar.
    expect(conversations).toEqual([
      { id: '785620ee-b9f6-4338-8cda-5ccaacce6be4', title: 'Repository setup', updated: '9m ago' },
      { id: '11111111-2222-3333-4444-555555555555', title: '[empty]', updated: '1h ago' },
    ]);
  });
});

describe('parseForgeInfo', () => {
  it('keeps status chip fields and ignores masked credentials', () => {
    // Given: Forge info porcelain includes model, provider, masked key, and conversation id.
    const output = [
      'AGENT         model           deepseek-v4-flash',
      'AGENT         provider (url)  https://opencode.ai/zen/go',
      'AGENT         api key         sk-redacted...tail',
      'CONVERSATION  id              785620ee-b9f6-4338-8cda-5ccaacce6be4',
    ].join('\n');

    // When: the output is parsed for panel metadata.
    const info = parseForgeInfo(output);

    // Then: only non-secret status chip fields are retained.
    expect(info).toEqual({
      model: 'deepseek-v4-flash',
      providerUrl: 'https://opencode.ai/zen/go',
      conversationId: '785620ee-b9f6-4338-8cda-5ccaacce6be4',
    });
  });
});

describe('useForgeAuxiliary', () => {
  it('loads list, info, and markdown preview through Forge CLI commands', async () => {
    // Given: a command runner that returns real-shaped Forge porcelain output.
    const { calls, runCommand } = createCommandRunner([
      [
        'ID                                    TITLE             UPDATED',
        '785620ee-b9f6-4338-8cda-5ccaacce6be4  Repository setup  9m ago',
      ].join('\n'),
      [
        'AGENT         model           deepseek-v4-flash',
        'AGENT         provider (url)  https://opencode.ai/zen/go',
        'CONVERSATION  id              785620ee-b9f6-4338-8cda-5ccaacce6be4',
      ].join('\n'),
      'Markdown preview',
    ]);
    const auxiliary = useForgeAuxiliary(runCommand);

    // When: the panel refreshes structured auxiliary metadata.
    await auxiliary.refreshAll();

    // Then: each read uses Forge's structured CLI surface, not the live PTY input stream.
    expect(calls).toEqual([
      { command: 'forge', args: ['list', 'conversation', '--porcelain'] },
      { command: 'forge', args: ['info', '--porcelain'] },
      { command: 'forge', args: ['conversation', 'show', '785620ee-b9f6-4338-8cda-5ccaacce6be4', '--md'] },
    ]);
    expect(auxiliary.conversations.value).toHaveLength(1);
    expect(auxiliary.selectedMarkdown.value).toBe('Markdown preview');
    expect(auxiliary.info.value?.model).toBe('deepseek-v4-flash');
  });

  it('loads JSON dumps through a temporary Forge dump command', async () => {
    // Given: a selected Forge conversation and a command runner.
    const { calls, runCommand } = createCommandRunner(['{"id":"conv-1"}']);
    const auxiliary = useForgeAuxiliary(runCommand);

    // When: the user requests a JSON dump preview.
    await auxiliary.dumpConversation('conv-1');

    // Then: dump uses `forge conversation dump <id>` inside an isolated temp directory.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: 'bash' });
    expect(calls[0]?.args.at(-1)).toBe('conv-1');
    expect(calls[0]?.args.join(' ')).toContain('forge conversation dump "$1"');
    expect(auxiliary.selectedDump.value).toBe('{"id":"conv-1"}');
  });
});
