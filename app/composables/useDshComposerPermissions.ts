import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';

type PermissionOption = { value: string; name: string; description?: string };
type PermissionClient = {
  getPermissionPresetOptions(sessionId: string): Promise<PermissionOption[]>;
  selectPermissionPreset(sessionId: string, preset: string): Promise<void>;
};

export function useDshComposerPermissions(options: {
  readonly client: Readonly<Ref<PermissionClient | undefined>>;
  readonly sessionId: Readonly<Ref<string>>;
  readonly current: Readonly<Ref<string>>;
  readonly preset: Readonly<Ref<string | undefined>>;
  readonly disabled: Readonly<Ref<boolean>>;
  readonly onError: (message: string) => void;
}) {
  const catalog = ref<PermissionOption[]>([]);
  const selected = ref('');
  const loading = ref(false);
  const saving = ref(false);
  let generation = 0;
  onScopeDispose(() => { generation += 1; });
  watch(options.current, (value) => { selected.value = value; });
  watch([options.client, options.sessionId, options.preset], async ([client, sessionId]) => {
    const request = ++generation;
    catalog.value = [];
    selected.value = options.current.value;
    saving.value = false;
    loading.value = Boolean(client && sessionId);
    if (!client || !sessionId) return;
    try {
      const result = await client.getPermissionPresetOptions(sessionId);
      if (request === generation) catalog.value = result;
    } catch (error) {
      if (request === generation) options.onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === generation) loading.value = false;
    }
  }, { immediate: true });
  const disabled = computed(() => options.disabled.value || loading.value || saving.value || !catalog.value.length);
  async function select(value: string) {
    const client = options.client.value;
    if (!client || disabled.value || value === selected.value || !catalog.value.some((option) => option.value === value)) return;
    const request = generation;
    const sessionId = options.sessionId.value;
    saving.value = true;
    try {
      await client.selectPermissionPreset(sessionId, value);
      if (request === generation) selected.value = value;
    } catch (error) {
      if (request === generation) options.onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === generation) saving.value = false;
    }
  }
  return { selected, loading, disabled, select, agentOptions: computed(() => catalog.value.map((option) => ({ id: option.value, label: option.name, description: option.description }))) };
}
