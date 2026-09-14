import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createCodexSessionControls } from './sessionControls';
import type { CodexConfigRequirementsReadResult } from './codexAdapter';

describe('Codex session controls', () => {
  it('preserves upstream defaults until Fast is explicitly switched off', async () => {
    const controls = createCodexSessionControls({
      models: ref([{ id: 'model', model: 'model', displayName: 'Model', defaultServiceTier: 'priority', serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }] }]),
      modelId: () => 'model', config: ref({ config: {} }), requirements: ref(null),
      writeTier: async () => {}, refreshRequirements: async () => {},
    });
    expect(controls.promptSettings()).not.toHaveProperty('serviceTier');
    expect(controls.selectedServiceTier.value).toBe('priority');
    await controls.setFastMode(false);
    expect(controls.promptSettings()).toHaveProperty('serviceTier', 'default');
  });
  it('uses the catalog tier and persists it before applying when Fast is enabled', async () => {
    const writeTier = vi.fn(async () => {});
    const controls = createCodexSessionControls({
      models: ref([{ id: 'model', model: 'model', displayName: 'Model', serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }] }]),
      modelId: () => 'model', config: ref(null), requirements: ref(null), writeTier, refreshRequirements: async () => {},
    });
    await controls.setFastMode(true);
    expect(writeTier).toHaveBeenCalledWith('priority');
    expect(controls.promptSettings().serviceTier).toBe('priority');
    await controls.setFastMode(false);
    expect(controls.promptSettings().serviceTier).toBe('default');
  });
  it('rejects unsupported Fast and permissions prohibited by server requirements', async () => {
    const requirements = ref<CodexConfigRequirementsReadResult['requirements']>({ allowedSandboxModes: ['read-only'] });
    const controls = createCodexSessionControls({
      models: ref([]), modelId: () => '', config: ref(null), requirements,
      writeTier: async () => {}, refreshRequirements: async () => {},
    });
    await expect(controls.setFastMode(true)).rejects.toThrow('Fast');
    await expect(controls.setPermissionMode('full-access')).rejects.toThrow('禁止');
    await controls.setPermissionMode('read-only');
    expect(controls.promptSettings()).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' }, thread: { sandbox: 'read-only' } });
  });
});

it('fences pending permission changes and normalizes Fast when model changes', async () => {
  let resolveRequirements: () => void = () => {};
  const waiting = new Promise<void>((resolve) => { resolveRequirements = resolve; });
  const selected = ref('fast-model');
  const controls = createCodexSessionControls({
    models: ref([
      { id: 'fast-model', model: 'fast-model', displayName: 'Fast', serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }] },
      { id: 'other', model: 'other', displayName: 'Other' },
    ]), modelId: () => selected.value, config: ref({ config: { service_tier: 'priority' } }), requirements: ref(null),
    writeTier: async () => {}, refreshRequirements: () => waiting,
  });
  const change = controls.setPermissionMode('full-access');
  controls.resetPermissions();
  resolveRequirements();
  await expect(change).rejects.toThrow('切换');
  expect(controls.selectedPermissionMode.value).toBe('');
  expect(controls.selectedServiceTier.value).toBe('priority');
  selected.value = 'other';
  expect(controls.promptSettings().serviceTier).toBe('default');
});
