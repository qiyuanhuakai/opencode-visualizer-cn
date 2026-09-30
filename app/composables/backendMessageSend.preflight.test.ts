import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { prepareSendPreflight } from './backendMessageSend.preflight';
import type { BackendKind } from '../backends/types';
import type { BackendMessageSendParams, SendPreflight } from './backendMessageSend.types';
import type { ComposerAttachment } from '../types/composer';

/**
 * Preflight failure-kind mapping per backend. The dsh mapping (plan Todo 25)
 * is pinned here WITHOUT touching the existing kimi-web / codex / opencode
 * mappings: those keep their own semantics and are asserted unchanged.
 */
function createParams(
  overrides: Partial<BackendMessageSendParams> = {},
): BackendMessageSendParams & {
  setSendStatusText: ReturnType<typeof vi.fn>;
  setSendStatusKey: ReturnType<typeof vi.fn>;
  ensureSelectedModelAvailable: ReturnType<typeof vi.fn>;
} {
  return {
    activeBackendKind: ref<BackendKind>('opencode'),
    selectedSessionId: ref('session-1'),
    selectedModel: ref('provider/model-1'),
    selectedMode: ref('build'),
    selectedThinking: ref<string | undefined>(undefined),
    activeDirectory: ref('/repo'),
    messageInput: ref('hello world'),
    attachments: ref<ComposerAttachment[]>([]),
    filteredSessions: ref([{ id: 'session-1' }]),
    modelOptions: ref([{ id: 'provider/model-1', providerID: 'provider', modelID: 'model-1' }]),
    setSendStatusText: vi.fn(),
    setSendStatusKey: vi.fn(),
    ensureSelectedModelAvailable: vi.fn(),
    pickPreferredSessionId: (list: Array<{ id: string }>) => list[0]?.id || '',
    parseSlashCommand: () => null,
    findCommandByName: () => null,
    parseProviderModelKey: (value: string) => {
      const [providerID = '', modelID = ''] = value.split('/');
      return { providerID, modelID };
    },
    normalizeProjectDirectoryForActiveBackend: (directory: string) => directory,
    isProviderEnabled: () => true,
    isModelAvailable: () => true,
    ...overrides,
  } as unknown as BackendMessageSendParams & {
    setSendStatusText: ReturnType<typeof vi.fn>;
    setSendStatusKey: ReturnType<typeof vi.fn>;
    ensureSelectedModelAvailable: ReturnType<typeof vi.fn>;
  };
}

function preflightFor(overrides: Partial<BackendMessageSendParams> = {}): SendPreflight | null {
  return prepareSendPreflight(createParams(overrides));
}

describe('prepareSendPreflight dsh mapping', () => {
  it('does not fail dsh sends on OpenCode provider/model availability', () => {
    const preflight = preflightFor({
      activeBackendKind: ref<BackendKind>('dsh'),
      selectedModel: ref('deepseek-official/deepseek-flash'),
      modelOptions: ref([]),
      isProviderEnabled: () => false,
      isModelAvailable: () => false,
    });

    expect(preflight).not.toBeNull();
    expect(preflight?.backend).toBe('dsh');
    expect(preflight?.sessionId).toBe('session-1');
  });

  it('refuses dsh sends with attachments before dispatch', () => {
    const params = createParams({
      activeBackendKind: ref<BackendKind>('dsh'),
      attachments: ref<ComposerAttachment[]>([
        {
          id: 'a1',
          filename: 'img.png',
          mime: 'image/png',
          dataUrl: 'data:image/png;base64,AA==',
        },
      ]),
    });

    expect(prepareSendPreflight(params)).toBeNull();
    expect(params.setSendStatusText).toHaveBeenCalledWith(
      'dsh supports text prompts only; attachments are not supported.',
    );
  });

  it('keeps reporting no session selected for dsh when no session exists', () => {
    const params = createParams({
      activeBackendKind: ref<BackendKind>('dsh'),
      filteredSessions: ref([]),
      selectedSessionId: ref('session-1'),
    });

    expect(prepareSendPreflight(params)).toBeNull();
    expect(params.setSendStatusKey).toHaveBeenCalledWith('app.error.noSessionSelected');
  });
});

describe('prepareSendPreflight existing mappings stay unchanged', () => {
  it('keeps bypassing the OpenCode model gate for kimi-web', () => {
    const preflight = preflightFor({
      activeBackendKind: ref<BackendKind>('kimi-web'),
      selectedModel: ref('kimi-code/k3'),
      modelOptions: ref([]),
      isProviderEnabled: () => false,
      isModelAvailable: () => false,
    });

    expect(preflight).not.toBeNull();
    expect(preflight?.backend).toBe('kimi-web');
  });

  it('keeps deriving the kimi-web default thinking from the selected variants', () => {
    const preflight = preflightFor({
      activeBackendKind: ref<BackendKind>('kimi-web'),
      selectedModel: ref('kimi-code/k3'),
      modelOptions: ref([
        {
          id: 'kimi-code/k3',
          providerID: 'kimi-code',
          modelID: 'k3',
          variants: { low: { default: false }, high: { default: true } },
        },
      ]),
    });

    expect(preflight?.selectedThinking).toBe('high');
  });

  it('keeps failing opencode sends without an enabled provider/model', () => {
    const params = createParams({
      activeBackendKind: ref<BackendKind>('opencode'),
      selectedModel: ref('provider/model-1'),
      isProviderEnabled: () => false,
    });

    expect(prepareSendPreflight(params)).toBeNull();
    expect(params.setSendStatusText).toHaveBeenCalledWith(
      'Select an enabled provider/model before sending.',
    );
    expect(params.ensureSelectedModelAvailable).toHaveBeenCalledTimes(1);
  });

  it('keeps letting opencode sends through with an enabled provider/model', () => {
    const preflight = preflightFor({ activeBackendKind: ref<BackendKind>('opencode') });

    expect(preflight).not.toBeNull();
    expect(preflight?.backend).toBe('opencode');
    expect(preflight?.modelProvider).toBe('provider');
    expect(preflight?.modelId).toBe('model-1');
  });

  it('keeps the codex mapping on an empty model and the normalized directory', () => {
    const preflight = preflightFor({
      activeBackendKind: ref<BackendKind>('codex'),
      isProviderEnabled: () => false,
      isModelAvailable: () => false,
    });

    expect(preflight).not.toBeNull();
    expect(preflight?.backend).toBe('codex');
    expect(preflight?.modelProvider).toBeUndefined();
    expect(preflight?.modelId).toBeUndefined();
    expect(preflight?.codexDirectory).toBe('/repo');
  });
});
