<template>
  <section class="agent-manager" :aria-busy="pending">
    <div class="toolbar"><button :disabled="pending" @click="refresh">{{ t('refresh') }}</button></div>
    <p v-if="pending" role="status">{{ t('loading') }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <h3>{{ t('defaultSubagentModel') }}</h3>
    <p class="hint">{{ t('defaultSubagentHint') }}</p>
    <form class="toolbar" @submit.prevent="saveDefaultSubagentModel">
      <select v-model="defaultSubagentModel" :aria-label="t('defaultSubagentModel')" :disabled="pending || !availableSubagentModels.length">
        <option v-for="item in availableSubagentModels" :key="item.model" :value="item.model">{{ item.display_name || item.model }}</option>
      </select>
      <button :disabled="pending || !defaultSubagentModel">{{ t('save') }}</button>
    </form>
    <h3>{{ t('children') }}</h3>
    <p class="hint">{{ t('childHint') }}</p>
    <form class="toolbar child-form" @submit.prevent="createChild">
      <input v-model="title" :aria-label="t('title')" :placeholder="t('title')" :disabled="pending" />
      <button :disabled="pending || !title.trim()">{{ t('create') }}</button>
    </form>
    <p v-if="loaded && !children.length" class="hint">{{ t('empty') }}</p>
    <article v-for="child in children" :key="child.id">
      <div class="toolbar"><strong>{{ child.title || child.id }}</strong><button :disabled="pending" @click="emit('open-session', child)">{{ t('open') }}</button><button :disabled="pending || child.busy" @click="configure(child)">{{ t('configure') }}</button></div>
      <form v-if="editingId === child.id" class="settings" @submit.prevent="save">
        <label>{{ t('model') }}<select v-model="model" :disabled="pending"><option v-for="item in models" :key="item.model" :value="item.model">{{ item.display_name || item.model }}</option></select></label>
        <label>{{ t('thinking') }}<select v-model="thinking" :disabled="pending || !efforts.length"><option value="">{{ t('default') }}</option><option v-for="effort in efforts" :key="effort" :value="effort">{{ effort }}</option></select></label>
        <label>{{ t('permission') }}<select v-model="permission" :disabled="pending"><option value="manual">manual</option><option value="auto">auto</option><option value="yolo">yolo</option></select></label>
        <button :disabled="pending || !model">{{ t('save') }}</button>
      </form>
    </article>
    <h3>{{ t('tasks') }}</h3>
    <p class="hint">{{ t('taskHint') }}</p>
    <p v-if="loaded && !tasks.length" class="hint">{{ t('empty') }}</p>
    <article v-for="task in tasks" :key="task.id">
      <div class="toolbar"><strong>{{ task.description || task.agent_id || task.id }}</strong><span>{{ task.status }}</span><button v-if="task.status === 'running'" :disabled="pending" @click="stop(task.id)">{{ t('stop') }}</button></div>
      <p class="hint">{{ [task.model, task.thinking_effort].filter(Boolean).join(' · ') }}</p>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { KimiWebClient, KimiWebModel, KimiWebSession, KimiWebSubagent } from '../../utils/kimiWeb';
import { isKimiWebPermissionMode } from '../../backends/kimiWeb/sessionModes';
import type { KimiWebPermissionMode } from '../../backends/kimiWeb/sessionModes';
import { kimiWebAgentsUi } from '../../locales/kimiWebAgentsUi';
const props = defineProps<{ sessionId: string; client: KimiWebClient }>();
const emit = defineEmits<{ 'open-session': [session: KimiWebSession]; 'session-updated': [session: KimiWebSession] }>();
const { t } = useI18n({ useScope: 'local', messages: kimiWebAgentsUi });
const children = ref<KimiWebSession[]>([]);
const tasks = ref<KimiWebSubagent[]>([]);
const models = ref<KimiWebModel[]>([]);
const defaultSubagentModel = ref('');
const configuredSubagentModels = ref<string[]>([]);
const availableSubagentModels = computed(() => configuredSubagentModels.value.length
  ? models.value.filter((item) => configuredSubagentModels.value.includes(item.model))
  : models.value);
const pending = ref(false);
const loaded = ref(false);
const error = ref('');
const notice = ref('');
const title = ref('');
const editingId = ref('');
const model = ref('');
const thinking = ref('');
const permission = ref<KimiWebPermissionMode>('manual');
const efforts = computed(() => models.value.find((item) => item.model === model.value)?.support_efforts ?? []);
watch(model, () => { if (!efforts.value.includes(thinking.value)) thinking.value = ''; });
type RequestScope = { readonly sessionId: string; readonly client: KimiWebClient; readonly current: () => boolean };
let generation = 0;
onBeforeUnmount(() => { generation++; });
async function run(operation: (scope: RequestScope) => Promise<void>, replace = false) {
  if (pending.value && !replace) return;
  const id = ++generation;
  const sessionId = props.sessionId;
  const client = props.client;
  const current = () => id === generation && sessionId === props.sessionId && client === props.client;
  pending.value = true; error.value = ''; notice.value = '';
  try { await operation({ sessionId, client, current }); }
  catch (cause) { if (current()) error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { if (current()) pending.value = false; }
}
async function load(scope: RequestScope) {
  const [nextChildren, nextTasks, nextModels, config] = await Promise.all([scope.client.listChildSessions(scope.sessionId), scope.client.listSessionTasks(scope.sessionId), scope.client.listModels(), scope.client.getConfig()]);
  if (!scope.current()) return;
  children.value = nextChildren;
  tasks.value = nextTasks.items.filter((task) => task.kind === 'subagent');
  models.value = nextModels.items;
  configuredSubagentModels.value = Object.keys(config.secondary_model?.models ?? {});
  defaultSubagentModel.value = config.secondary_model?.default_model ?? config.default_model ?? nextModels.items[0]?.model ?? '';
  loaded.value = true;
}
function refresh() { return run(load); }
function saveDefaultSubagentModel() {
  const selected = defaultSubagentModel.value;
  if (!selected || !availableSubagentModels.value.some((item) => item.model === selected)) return;
  return run(async (scope) => {
    await scope.client.updateConfig({ secondary_model: { default_model: selected } });
    if (scope.current()) notice.value = t('saved');
  });
}
function createChild() {
  const name = title.value.trim();
  if (!name) return;
  return run(async (scope) => {
    const child = await scope.client.createChildSession(scope.sessionId, name);
    if (!scope.current()) return;
    if (!child.metadata) throw new Error('Kimi Web child session is missing its directory.');
    emit('session-updated', { ...child, metadata: { ...child.metadata, parent_session_id: scope.sessionId } });
    title.value = '';
    await load(scope);
  });
}
function configure(child: KimiWebSession) {
  return run(async (scope) => {
    const status = await scope.client.getSessionStatus(child.id);
    if (!scope.current()) return;
    model.value = status.model ?? child.agent_config?.model ?? '';
    permission.value = isKimiWebPermissionMode(status.permission) ? status.permission : 'manual';
    thinking.value = status.thinking_level ?? '';
    editingId.value = child.id;
  });
}
function save() {
  const childId = editingId.value;
  const selectedModel = model.value;
  const selectedPermission = permission.value;
  const effort = thinking.value || models.value.find((item) => item.model === selectedModel)?.default_effort || efforts.value[0];
  return run(async (scope) => {
    const session = await scope.client.updateProfile(childId, { agent_config: { model: selectedModel, permission_mode: selectedPermission, ...(effort ? { thinking: effort } : {}) } });
    if (!scope.current()) return;
    emit('session-updated', session);
    children.value = children.value.map((child) => child.id === session.id ? session : child);
    editingId.value = '';
    notice.value = t('saved');
  });
}
function stop(taskId: string) { return run(async (scope) => { await scope.client.cancelSessionTask(scope.sessionId, taskId); if (scope.current()) await load(scope); }); }
watch([() => props.sessionId, () => props.client], () => {
  loaded.value = false; children.value = []; tasks.value = []; models.value = []; configuredSubagentModels.value = []; defaultSubagentModel.value = ''; editingId.value = ''; title.value = '';
  void run(load, true);
}, { immediate: true, flush: 'sync' });
</script>

<style scoped>
.agent-manager { height: 100%; overflow: auto; box-sizing: border-box; padding: 12px; color: var(--theme-floating-text, var(--theme-text-primary)); background: var(--theme-floating-surface-base, var(--theme-surface-panel)); font-size: 12px; }
h3 { font-size: 14px; margin: 10px 0 6px; }
p { margin: 6px 0; overflow-wrap: anywhere; }
.hint { color: var(--theme-text-muted); }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
strong { flex: 1; min-width: 120px; overflow-wrap: anywhere; }
article { padding: 12px; margin-top: 8px; border: 1px solid var(--theme-floating-border-muted, var(--theme-border-default)); border-radius: 8px; }
input, select, button { font: inherit; color: inherit; background: var(--theme-floating-surface-subtle, var(--theme-surface-panel-muted)); border: 1px solid var(--theme-floating-border-muted, var(--theme-border-default)); border-radius: 8px; padding: 4px 8px; max-width: 100%; box-sizing: border-box; }
input { flex: 1; min-width: 120px; }
button { cursor: pointer; }
button:hover:not(:disabled) { background: var(--theme-floating-surface-strong, var(--theme-surface-panel-hover)); }
:disabled { opacity: .5; cursor: default; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--theme-border-accent); }
.settings { display: grid; gap: 8px; margin-top: 12px; }
label { display: grid; gap: 4px; }
[role="alert"] { color: var(--theme-status-error); }
</style>
