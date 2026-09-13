import { beforeEach, describe, expect, it } from 'vitest';
import { createCodexMessageModels } from './messageModels';
import { normalizeCodexTurnsToHistory } from './normalize';
import { StorageKeys, storageSetJSON } from '../../utils/storageKeys';

function history(model = { providerID: 'codex', modelID: 'codex' }) {
  return normalizeCodexTurnsToHistory({ sessionId: 'thread', model, turns: [{ id: 'turn', startedAt: 1, items: [
    { type: 'userMessage', id: 'first', content: [{ type: 'text', text: 'First' }] },
    { type: 'agentMessage', id: 'answer-first', text: 'First answer' },
    { type: 'userMessage', id: 'second', content: [{ type: 'text', text: 'Second' }] },
    { type: 'agentMessage', id: 'answer-second', text: 'Second answer' },
  ] }] });
}

describe('Codex message model snapshots', () => {
  beforeEach(() => localStorage.clear());

  it('restores independently captured modes without adding agent fields to models', () => {
    // Given distinct user modes, including a prompt with an unknown model.
    const models = createCodexMessageModels(() => 'ws://example.test/rpc');
    history().forEach((entry, index) => models.save('thread', { ...entry.info, agent: index === 0 ? 'plan' : 'default' }));
    // When history is reconstructed from storage.
    const restored = createCodexMessageModels(() => 'ws://example.test/rpc').restore('thread', history());
    // Then each assistant inherits only its own parent's mode.
    expect(restored.map(({ info }) => info.agent)).toEqual(['plan', 'plan', 'default', 'default']);
    expect(restored[0]?.info).toMatchObject({ model: { providerID: 'codex', modelID: 'codex' } });
    expect(restored.filter(({ info }) => info.role === 'assistant').map(({ info }) => info.role === 'assistant' && info.mode)).toEqual(['codex', 'codex']);
  });

  it('combines legacy model caches with live mode evidence and preserves named subagents', () => {
    // Given a legacy cache and an optimistic user with a known mode.
    const models = createCodexMessageModels(() => 'ws://example.test/rpc');
    storageSetJSON(`${StorageKeys.state.codexMessageModels}.${encodeURIComponent('ws://example.test/rpc')}.thread`, {
      'turn:user:first': { providerID: 'custom', modelID: 'legacy-model' },
    });
    const known = history().map(entry => ({ ...entry, info: { ...entry.info, agent: 'plan' } }));
    const entries = history().map((entry, index) => index === 3 ? { ...entry, info: { ...entry.info, agent: 'explorer' } } : entry);
    // When attribution is restored.
    const restored = models.restore('thread', entries, known);
    // Then legacy models and live modes survive independently.
    expect(restored[0]?.info).toMatchObject({ agent: 'plan', model: { providerID: 'custom', modelID: 'legacy-model' } });
    expect(restored.map(({ info }) => info.agent)).toEqual(['plan', 'plan', 'plan', 'explorer']);
    expect(models.restore('thread', history())[0]?.info.agent).toBe('codex');
  });

  it('maps the official wire provider back to the built-in UI catalog for uncached history', () => {
    const models = createCodexMessageModels(() => 'ws://example.test/rpc');
    expect(models.restore('thread', history({ providerID: 'openai', modelID: 'gpt-6-astra' }))[0]?.info)
      .toMatchObject({ model: { providerID: 'codex', modelID: 'gpt-6-astra' } });
    expect(models.restore('thread', history({ providerID: 'custom', modelID: 'gpt-6-astra' }))[0]?.info)
      .toMatchObject({ model: { providerID: 'custom', modelID: 'gpt-6-astra' } });
  });

  it('keeps supplemental models distinct and restores assistants from their user snapshot', () => {
    const models = createCodexMessageModels(() => 'ws://example.test/rpc');
    for (const entry of history({ providerID: 'codex', modelID: 'first-model' }).slice(0, 1)) models.save('thread', entry.info);
    for (const entry of history({ providerID: 'custom', modelID: 'second-model' }).slice(2, 3)) models.save('thread', entry.info);
    const fresh = createCodexMessageModels(() => 'ws://example.test/rpc');
    expect(fresh.restore('thread', history()).map(({ info }) => info.role === 'user' ? info.model : { providerID: info.providerID, modelID: info.modelID })).toEqual([
      { providerID: 'codex', modelID: 'first-model' }, { providerID: 'codex', modelID: 'first-model' },
      { providerID: 'custom', modelID: 'second-model' }, { providerID: 'custom', modelID: 'second-model' },
    ]);
  });

  it('isolates threads and endpoints while excluding credentials from the key', () => {
    const models = createCodexMessageModels(() => 'ws://name:secret@example.test/rpc?token=hidden');
    for (const entry of history({ providerID: 'custom', modelID: 'saved-model' })) models.save('thread', entry.info);
    const other = createCodexMessageModels(() => 'ws://other.test/rpc');
    expect(other.restore('thread', history())).toEqual(history());
    expect(models.restore('other-thread', history())).toEqual(history());
    expect(Object.keys(localStorage).join()).not.toMatch(/secret|hidden|name/);
  });

  it('does not replace a saved model with an unknown placeholder', () => {
    const models = createCodexMessageModels(() => 'ws://example.test/rpc');
    for (const entry of history({ providerID: 'codex', modelID: 'saved-model' })) models.save('thread', entry.info);
    for (const entry of history()) models.save('thread', entry.info);
    expect(models.restore('thread', history())[0]?.info).toMatchObject({ model: { modelID: 'saved-model' } });
  });

  it('ignores malformed stored models and preserves known live metadata before acknowledgement', () => {
    const models = createCodexMessageModels(() => 'ws://example.test/rpc');
    storageSetJSON(`${StorageKeys.state.codexMessageModels}.${encodeURIComponent('ws://example.test/rpc')}.thread`, {
      'turn:user:first': { providerID: 42, modelID: 'invalid' },
    });
    const known = history({ providerID: 'custom', modelID: 'live-model' });
    expect(models.restore('thread', history(), known)[0]?.info).toMatchObject({ model: { providerID: 'custom', modelID: 'live-model' } });
  });
});
