import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountCodexApp, mountHistoryApp } from './test/appHarness';
import { StorageKeys } from './utils/storageKeys';

const mountedApps: Array<{ readonly unmount: () => void }> = [];

afterEach(() => {
  mountedApps.splice(0).forEach(({ unmount }) => unmount());
});

async function selectComposerModel(host: HTMLElement, modelId: string) {
  const trigger = host.querySelector<HTMLButtonElement>(
    '.input-dropdown-root .input-dropdown-button',
  );
  expect(trigger).toBeInstanceOf(HTMLButtonElement);
  trigger?.click();
  await nextTick();
  const option = Array.from(
    host.querySelectorAll<HTMLElement>('.input-dropdown-root .ui-input-candidate-item'),
  ).find((candidate) => candidate.getAttribute('data-value') === JSON.stringify(modelId));
  expect(option).toBeInstanceOf(HTMLElement);
  option?.click();
  await nextTick();
}

async function enterAndSend(host: HTMLElement, text: string) {
  const textarea = host.querySelector<HTMLTextAreaElement>('.input-textarea');
  const send = host.querySelector<HTMLButtonElement>('.send-button');
  expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
  expect(send).toBeInstanceOf(HTMLButtonElement);
  if (!textarea) return;
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  send?.click();
}

describe('App provider model and ACP archive binding', () => {
  it('Given a real App with a slash-containing Codex model, When provider manager opens and hides it, Then App refreshes providers and stores the full model key without changing selection', async () => {
    const fixture = await mountHistoryApp([]);
    mountedApps.push(fixture);
    fixture.listProviders.mockResolvedValue({
      all: [
        {
          id: 'custom-provider',
          name: 'Custom Provider',
          source: 'config',
          models: {
            'org/model/v1': {
              id: 'org/model/v1',
              name: 'Slash Model',
              providerID: 'custom-provider',
            },
          },
        },
      ],
      connected: ['custom-provider'],
      default: {},
    });
    fixture.setStoredBackendKind('codex');
    await vi.waitFor(() => expect(fixture.readSetupBinding('activeBackendKind')).toBe('codex'));
    await vi.waitFor(() => expect(fixture.readSetupBinding('providersLoaded')).toBe(true));
    fixture.listProviders.mockClear();
    fixture.getGlobalConfig.mockClear();
    const selectedBefore = fixture.readSetupBinding('selectedModel');
    const fetchCountBeforeOpen = fixture.readSetupBinding('providersFetchCount');

    const open = fixture.host.querySelector<HTMLButtonElement>('.provider-manager-button');
    expect(open).toBeInstanceOf(HTMLButtonElement);
    open?.click();
    await vi.waitFor(() =>
      expect(fixture.readSetupBinding('providersFetchCount')).toBe(
        Number(fetchCountBeforeOpen) + 1,
      ),
    );
    await vi.waitFor(() => expect(fixture.listProviders).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(fixture.getGlobalConfig).toHaveBeenCalled());
    const modelsTab = Array.from(
      fixture.host.querySelectorAll<HTMLButtonElement>('.provider-manager-tab'),
    ).find((button) => button.getAttribute('aria-selected') === 'false');
    expect(modelsTab).toBeInstanceOf(HTMLButtonElement);
    modelsTab?.click();
    await nextTick();
    const toggle = fixture.host.querySelector<HTMLInputElement>('.model-row .toggle-input');
    expect(toggle).toBeInstanceOf(HTMLInputElement);
    if (toggle) {
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await nextTick();

    expect(fixture.readSetupBinding('hiddenModels')).toEqual(['custom-provider/org/model/v1']);
    expect(fixture.readSetupBinding('selectedModel')).toBe(selectedBefore);
  });

  it('Given a ready real App, When ACP publishes an archived session, Then App projects the archived time into its live session state', async () => {
    const fixture = await mountHistoryApp([]);
    mountedApps.push(fixture);

    fixture.setStoredBackendKind('acp');
    fixture.dispatchStorageChange(StorageKeys.auth.acpAgentId, 'oh-my-pi');
    await nextTick();
    fixture.emitAcpEvent({
      type: 'session.updated',
      info: {
        id: 'archived-acp-session',
        title: 'Archived ACP session',
        status: 'idle',
        directory: '/repo',
        time: { created: 10, updated: 20, archived: 30 },
      },
    });

    await vi.waitFor(() =>
      expect(fixture.readSetupBinding('serverState')).toMatchObject({
        projects: {
          acp: {
            sandboxes: {
              '/repo': {
                sessions: {
                  'archived-acp-session': { timeArchived: 30 },
                },
              },
            },
          },
        },
      }),
    );
  });

  it('Given a mounted Codex App with an openai thread, When the user sends with official then custom models through the composer, Then official reuses the openai thread while custom starts a fresh thread', async () => {
    const fixture = await mountCodexApp();
    mountedApps.push(fixture);

    await selectComposerModel(fixture.host, 'openai/official-model');
    await enterAndSend(fixture.host, 'official provider message');
    await vi.waitFor(() =>
      expect(fixture.codexAdapterSendPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'official provider message', threadId: 'thread-openai' }),
      ),
    );
    expect(fixture.codexSendPrompt).toHaveBeenCalledWith(
      'official provider message',
      expect.objectContaining({ forceNewThread: false, threadId: 'thread-openai' }),
    );

    await selectComposerModel(fixture.host, 'custom-provider/custom-model');
    await enterAndSend(fixture.host, 'custom provider message');
    await vi.waitFor(() => expect(fixture.codexAdapterSendPrompt).toHaveBeenCalledTimes(2));
    expect(fixture.codexBatchWriteConfig).toHaveBeenLastCalledWith({
      edits: [
        { keyPath: 'model_provider', value: 'custom-provider', mergeStrategy: 'replace' },
        { keyPath: 'model', value: 'custom-model', mergeStrategy: 'replace' },
      ],
    });
    expect(fixture.codexSendPrompt).toHaveBeenLastCalledWith(
      'custom provider message',
      expect.objectContaining({ forceNewThread: true, threadId: undefined }),
    );
    const customInput = fixture.codexAdapterSendPrompt.mock.calls[1]?.[0];
    expect(customInput).toMatchObject({ text: 'custom provider message' });
    expect(customInput).not.toHaveProperty('threadId');
  });
});
