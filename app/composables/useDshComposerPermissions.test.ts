import { effectScope, nextTick, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import { useDshComposerPermissions } from './useDshComposerPermissions';

type Option = { value: string; name: string };
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it('ignores a stale catalog and refreshes permissions after mode changes', async () => {
  const old = deferred<Option[]>();
  const getPermissionPresetOptions = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue([{ value: 'read-only', name: 'Read only' }]);
  const sessionId = ref('old'); const preset = ref('standard');
  const scope = effectScope();
  const controls = scope.run(() => useDshComposerPermissions({ client: ref({ getPermissionPresetOptions, selectPermissionPreset: vi.fn() }), sessionId, preset, current: ref('read-only'), disabled: ref(false), onError: vi.fn() }));
  if (!controls) throw new Error('Missing controls');
  sessionId.value = 'new'; await nextTick(); await nextTick();
  old.resolve([{ value: 'danger-full-access', name: 'Wrong session' }]); await nextTick(); await nextTick();
  expect(controls.agentOptions.value.map(option => option.id)).toEqual(['read-only']);
  preset.value = 'minimal'; await nextTick(); await nextTick();
  expect(getPermissionPresetOptions).toHaveBeenLastCalledWith('new');
  expect(getPermissionPresetOptions).toHaveBeenCalledTimes(3);
  scope.stop();
});

it('does not publish a completed permission write into a different session', async () => {
  const pending = deferred<void>(); const sessionId = ref('old'); const current = ref('read-only');
  const client = ref({ getPermissionPresetOptions: async () => [{ value: 'read-only', name: 'Read only' }, { value: 'workspace-write', name: 'Workspace' }], selectPermissionPreset: () => pending.promise });
  const scope = effectScope();
  const controls = scope.run(() => useDshComposerPermissions({ client, sessionId, current, preset: ref('standard'), disabled: ref(false), onError: vi.fn() }));
  if (!controls) throw new Error('Missing controls');
  await nextTick(); await nextTick();
  const saving = controls.select('workspace-write');
  sessionId.value = 'new'; await nextTick();
  pending.resolve(); await saving;
  expect(controls.selected.value).toBe('read-only');
  scope.stop();
});
