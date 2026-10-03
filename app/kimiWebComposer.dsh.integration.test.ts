import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, watchEffect } from 'vue';
import { useDshComposerPermissions } from './composables/useDshComposerPermissions';
import { cleanupInputPanelFixtures, mountInputPanel } from './components/inputPanel.test-helpers';
import en from './locales/en';

vi.mock('@iconify/vue', () => ({ Icon: { render: () => null } }));
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); cleanupInputPanelFixtures(); document.body.innerHTML = ''; });
function mount(options: { reject?: boolean; disabled?: boolean } = {}) {
  const error = ref('');
  const writes: Array<{ sessionId: string; preset: string }> = [];
  const client = ref({
    getPermissionPresetOptions: async () => [{ value: 'read-only', name: 'Read only' }, { value: 'workspace-write', name: 'Workspace' }],
    selectPermissionPreset: async (sessionId: string, preset: string) => {
      if (options.reject) throw new Error('Permission command rejected');
      writes.push({ sessionId, preset });
    },
  });
  const scope = effectScope();
  const controls = scope.run(() => useDshComposerPermissions({ client, current: ref('workspace-write'), sessionId: ref('selected-session'), preset: ref('standard'), disabled: ref(options.disabled ?? false), onError: message => { error.value = message; } }));
  if (!controls) throw new Error('Missing controls');
  scopes.push(scope);
  const view = mountInputPanel({ agentOptions: [], selectedMode: controls.selected.value, agentPickerTitle: en.inputPanel.permissionModeTitle, 'onUpdate:selectedMode': controls.select });
  scope.run(() => watchEffect(() => {
    view.props.agentOptions = controls.agentOptions.value;
    view.props.hasAgentOptions = controls.agentOptions.value.length > 0;
    view.props.selectedMode = controls.selected.value;
    view.props.agentPickerDisabled = controls.disabled.value;
  }));
  return { root: view.root, writes, error };
}
async function choose(root: HTMLElement) {
  await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false));
  root.querySelector<HTMLButtonElement>('button')?.click(); await nextTick();
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(entry => entry.textContent?.includes('Read only'));
  if (!option) throw new Error('Missing read-only option');
  option.click();
}
it('changes the selected session and displays the authoritative permission readback', async () => {
  const { root, writes } = mount(); await choose(root);
  await vi.waitFor(() => expect(root.querySelector('button')?.textContent).toContain('Read only'));
  expect(writes).toEqual([{ sessionId: 'selected-session', preset: 'read-only' }]);
});
it('surfaces remote rejection and retains the previous preset', async () => {
  const { root, writes, error } = mount({ reject: true }); await choose(root);
  await vi.waitFor(() => expect(error.value).toContain('Permission command rejected'));
  expect(root.querySelector('button')?.textContent).toContain('Workspace'); expect(writes).toEqual([]);
});
it('disables writes while the session is busy', async () => {
  const { root, writes } = mount({ disabled: true }); await nextTick();
  expect(root.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true); expect(writes).toEqual([]);
});
it('places DSH permissions before input controls and management after thinking', () => {
  const source = readFileSync(join(process.cwd(), 'app', 'App.vue'), 'utf8');
  expect(source).toMatch(/<template #after-agent>[\s\S]*DshComposerMode/);
  expect(source).not.toContain('<DshComposerPermissions');
  expect(source).toContain(':selected-mode="dshComposerClient ? dshPermissionControls.selected.value : selectedMode"');
  expect(source).toMatch(/<template #after-thinking>[\s\S]*KimiWebComposerActions[\s\S]*DshComposerActions/);
  expect(source).not.toContain('dsh-composer-preset-badge');
});
