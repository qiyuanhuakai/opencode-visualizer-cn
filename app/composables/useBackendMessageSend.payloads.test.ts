import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useBackendMessageSend } from './useBackendMessageSend';
import { createBaseParams, createCodexApi } from './useBackendMessageSend.test-helpers';

describe('useBackendMessageSend payloads', () => {
  it('adds bounded file context parts for ACP @ mentions', async () => {
    const base = createBaseParams();
    base.messageInput.value = 'Review @src/auth.ts';
    base.resolveAgentMode = () => 'acceptEdits';
    base.parseAtAgent = () => ({ agent: 'src/auth.ts', text: 'Review' });
    base.findAgentByName = () => null;
    base.buildAcpMentionContextParts = vi.fn().mockResolvedValue([
      {
        type: 'text',
        text: 'Referenced file: src/auth.ts\n```ts\nexport const auth = true;\n```',
      },
    ]);
    const sendPromptAsync = vi.fn().mockResolvedValue(undefined);
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('acp'),
      openCodeApi: { sendPromptAsync },
      codexApi: createCodexApi(),
    });

    await runtime.sendMessage();

    expect(base.buildAcpMentionContextParts).toHaveBeenCalledWith('Review @src/auth.ts');
    expect(sendPromptAsync).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        agent: 'acceptEdits',
        parts: expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining('Referenced file') }),
        ]),
      }),
    );
  });

  it('sends ACP prompts through the shared sendPromptAsync path', async () => {
    const base = createBaseParams();
    base.selectedModel.value = 'acp/default';
    base.modelOptions.value = [{ id: 'acp/default', providerID: 'acp', modelID: 'default' }];
    const sendPromptAsync = vi.fn().mockResolvedValue(undefined);
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('acp'),
      openCodeApi: { sendPromptAsync },
      codexApi: createCodexApi(),
    });

    await runtime.sendMessage();

    expect(sendPromptAsync).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        directory: '/repo',
        model: { providerID: 'acp', modelID: 'default' },
        parts: [{ type: 'text', text: 'hello world' }],
      }),
    );
  });

  it('attaches $skill-name tokens before text on Codex backend', async () => {
    const base = createBaseParams();
    base.messageInput.value = '$skill-creator add a new skill for CI';
    const codexApi = createCodexApi();
    base.parseSkill = (input: string) =>
      input.includes('$skill-creator')
        ? [{ name: 'skill-creator', path: '/abs/skill-creator/SKILL.md' }]
        : [];
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('codex'),
      openCodeApi: { sendPromptAsync: vi.fn() },
      codexApi,
      availableSkills: ref([
        {
          name: 'skill-creator',
          description: 'd',
          enabled: true,
          path: '/abs/skill-creator/SKILL.md',
        },
      ]),
    });

    await runtime.sendMessage();

    expect(codexApi.sendPrompt.mock.calls[0]?.[1]).toMatchObject({
      input: [
        { type: 'skill', name: 'skill-creator', path: '/abs/skill-creator/SKILL.md' },
        { type: 'text', text: '$skill-creator add a new skill for CI' },
      ],
    });
  });

  it('does not attach skill items without a $token on Codex backend', async () => {
    const base = createBaseParams();
    const codexApi = createCodexApi();
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('codex'),
      openCodeApi: { sendPromptAsync: vi.fn() },
      codexApi,
      availableSkills: ref([
        {
          name: 'skill-creator',
          description: 'd',
          enabled: true,
          path: '/abs/skill-creator/SKILL.md',
        },
      ]),
    });

    await runtime.sendMessage();

    expect(codexApi.sendPrompt.mock.calls[0]?.[1]).toMatchObject({ input: [{ type: 'text' }] });
  });

  it('does not attach skill items on OpenCode backend', async () => {
    const base = createBaseParams();
    base.messageInput.value = '$skill-creator hello';
    base.parseSkill = () => [{ name: 'skill-creator', path: '/abs/skill-creator/SKILL.md' }];
    const sendPromptAsync = vi.fn().mockResolvedValue(undefined);
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('opencode'),
      openCodeApi: { sendPromptAsync },
      codexApi: createCodexApi(),
    });

    await runtime.sendMessage();

    const parts = sendPromptAsync.mock.calls[0]?.[1].parts as Array<Record<string, unknown>>;
    expect(parts.some((part) => part.type === 'skill')).toBe(false);
  });
});
