<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import {
  useAcpBridge,
  type AcpAgentState,
  type BridgeServiceState,
} from '../composables/useAcpBridge';

const props = defineProps<{
  api?: ReturnType<typeof useAcpBridge>;
}>();

const { t } = useI18n();
const api = props.api ?? useAcpBridge();
const toggling = ref('');
const removing = ref('');
const showAddForm = ref(false);
const formError = ref('');
const actionError = ref('');
const agentId = ref('');
const agentName = ref('');
const agentCommand = ref('');
const agentArgs = ref('[]');
const presetIds = new Set(['pi', 'oh-my-pi', 'kimi-code']);

const visibleError = computed(() => actionError.value || api.error.value);

const stateClasses: Record<AcpAgentState | BridgeServiceState, string> = {
  disabled: 'bg-[var(--theme-status-neutral)]',
  stopped: 'bg-[var(--theme-status-neutral)]',
  starting: 'bg-[var(--theme-status-warning,#fbbf24)]',
  running: 'bg-[var(--theme-status-success,#34d399)]',
  adopted: 'bg-[var(--theme-status-info,#38bdf8)]',
  stopping: 'bg-[var(--theme-status-warning,#fbbf24)]',
  error: 'bg-[var(--theme-status-danger,#f87171)]',
};

function formatCommand(command: string, args: string[]) {
  return [command, ...args].join(' ');
}

async function toggleAgent(id: string, enabled: boolean) {
  toggling.value = id;
  actionError.value = '';
  try {
    await api.updateAgent(id, { enabled });
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    toggling.value = '';
  }
}

function closeAddForm() {
  showAddForm.value = false;
  formError.value = '';
  agentId.value = '';
  agentName.value = '';
  agentCommand.value = '';
  agentArgs.value = '[]';
}

async function addAgent() {
  const id = agentId.value.trim();
  const name = agentName.value.trim();
  const command = agentCommand.value.trim();
  if (!id || !name || !command || !/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
    formError.value = t('statusMonitor.acp.required');
    return;
  }
  let args: unknown;
  try {
    args = JSON.parse(agentArgs.value);
  } catch {
    formError.value = t('statusMonitor.acp.invalidArgs');
    return;
  }
  if (!Array.isArray(args) || !args.every((item) => typeof item === 'string')) {
    formError.value = t('statusMonitor.acp.invalidArgs');
    return;
  }
  try {
    await api.createAgent({ id, name, command, args, enabled: false });
    closeAddForm();
  } catch (error) {
    formError.value = error instanceof Error ? error.message : String(error);
  }
}

async function removeAgent(id: string) {
  removing.value = id;
  actionError.value = '';
  try {
    await api.removeAgent(id);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    removing.value = '';
  }
}

onMounted(() => {
  void api.refresh();
});

defineExpose({ refresh: api.refresh });
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3">
    <div v-if="visibleError" class="rounded-lg border border-[var(--theme-list-row-border)] bg-[var(--theme-list-row-bg)] px-3 py-2 text-xs text-[var(--theme-status-danger)]">
      {{ visibleError }}
    </div>
    <div v-if="api.loading.value && api.agents.value.length === 0" class="py-6 text-center text-xs text-[var(--theme-text-secondary)]">
      {{ $t('statusMonitor.loading') }}
    </div>
    <div v-else-if="!api.bridgeAvailable.value" class="py-6 text-center text-xs text-[var(--theme-text-secondary)]">
      {{ $t('statusMonitor.acp.unavailable') }}
    </div>
    <template v-else>
      <section v-if="api.services.value.length" class="grid gap-2">
        <div class="text-[10px] font-medium uppercase tracking-wide text-[var(--theme-text-muted,#64748b)]">
          {{ $t('statusMonitor.acp.services') }}
        </div>
        <div v-for="service in api.services.value" :key="service.id" class="flex min-w-0 items-center gap-3 rounded-lg border border-[var(--theme-list-row-border)] bg-[var(--theme-list-row-bg)] px-3 py-2.5">
          <span class="h-2 w-2 shrink-0 rounded-full" :class="stateClasses[service.state]" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-xs font-medium text-[var(--theme-text-primary,#e2e8f0)]">{{ service.name }}</span>
              <span class="text-[10px] uppercase tracking-wide text-[var(--theme-text-muted,#64748b)]">{{ $t(`statusMonitor.acp.states.${service.state}`) }}</span>
            </div>
            <div class="truncate font-mono text-[11px] text-[var(--theme-text-secondary,#94a3b8)]" :title="formatCommand(service.command, service.args)">
              {{ formatCommand(service.command, service.args) }}
            </div>
            <div v-if="service.error" data-service-startup-error class="whitespace-pre-wrap break-words text-[11px] text-[var(--theme-status-danger)]">{{ service.error }}</div>
          </div>
        </div>
      </section>

      <button
        v-if="!showAddForm"
        type="button"
        data-acp-add-toggle
        class="flex items-center justify-center gap-1.5 rounded-md border border-[var(--theme-list-row-border)] px-3 py-2 text-xs text-[var(--theme-text-secondary)] hover:bg-[var(--theme-list-row-hover-bg)]"
        @click="showAddForm = true"
      >
        <Icon icon="lucide:plus" :width="13" :height="13" />
        {{ $t('statusMonitor.acp.add') }}
      </button>

      <div v-if="showAddForm" class="grid gap-2 rounded-lg border border-[var(--theme-form-control-border)] bg-[var(--theme-form-control-bg)] p-3">
        <div class="text-xs font-medium text-[var(--theme-text-primary)]">{{ $t('statusMonitor.acp.addTitle') }}</div>
        <input v-model="agentId" data-acp-id class="rounded border border-[var(--theme-form-control-border)] bg-[var(--theme-form-control-bg)] px-2 py-1.5 text-xs text-[var(--theme-form-control-text)]" :placeholder="$t('statusMonitor.acp.id')" />
        <input v-model="agentName" data-acp-name class="rounded border border-[var(--theme-form-control-border)] bg-[var(--theme-form-control-bg)] px-2 py-1.5 text-xs text-[var(--theme-form-control-text)]" :placeholder="$t('statusMonitor.acp.name')" />
        <input v-model="agentCommand" data-acp-command class="rounded border border-[var(--theme-form-control-border)] bg-[var(--theme-form-control-bg)] px-2 py-1.5 text-xs text-[var(--theme-form-control-text)]" :placeholder="$t('statusMonitor.acp.command')" />
        <input v-model="agentArgs" data-acp-args class="rounded border border-[var(--theme-form-control-border)] bg-[var(--theme-form-control-bg)] px-2 py-1.5 font-mono text-xs text-[var(--theme-form-control-text)]" :placeholder="$t('statusMonitor.acp.args')" />
        <div v-if="formError" class="text-xs text-[var(--theme-status-danger)]">{{ formError }}</div>
        <div class="flex justify-end gap-2">
          <button type="button" class="px-2 py-1 text-xs text-[var(--theme-text-secondary)]" @click="closeAddForm">{{ $t('statusMonitor.acp.cancel') }}</button>
          <button type="button" data-acp-add-submit class="rounded border border-[var(--theme-form-button-primary-border)] bg-[var(--theme-form-button-primary-bg)] px-2.5 py-1 text-xs text-[var(--theme-form-button-primary-text)] hover:bg-[var(--theme-form-button-primary-hover-bg)]" @click="addAgent">{{ $t('statusMonitor.acp.add') }}</button>
        </div>
      </div>

      <div v-if="api.agents.value.length === 0" class="py-6 text-center text-xs text-[var(--theme-text-secondary)]">
        {{ $t('statusMonitor.acp.empty') }}
      </div>
      <div v-else class="grid gap-2">
        <div v-for="agent in api.agents.value" :key="agent.id" class="flex min-w-0 items-center gap-3 rounded-lg border border-[var(--theme-list-row-border)] bg-[var(--theme-list-row-bg)] px-3 py-2.5">
          <span class="h-2 w-2 shrink-0 rounded-full" :class="stateClasses[agent.state]" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-xs font-medium text-[var(--theme-text-primary,#e2e8f0)]">{{ agent.name }}</span>
              <span class="text-[10px] uppercase tracking-wide text-[var(--theme-text-muted,#64748b)]">{{ $t(`statusMonitor.acp.states.${agent.state}`) }}</span>
            </div>
            <div class="truncate font-mono text-[11px] text-[var(--theme-text-secondary,#94a3b8)]" :title="formatCommand(agent.command, agent.args)">
              {{ formatCommand(agent.command, agent.args) }}
            </div>
            <div class="flex gap-2 text-[10px] text-[var(--theme-text-muted,#64748b)]">
              <span>{{ $t(agent.connected ? 'statusMonitor.acp.connected' : 'statusMonitor.acp.disconnected') }}</span>
              <span v-if="agent.droppedFrames > 0">{{ $t('statusMonitor.acp.droppedFrames', { count: agent.droppedFrames }) }}</span>
            </div>
            <div v-if="agent.error" data-agent-startup-error class="whitespace-pre-wrap break-words text-[11px] text-[var(--theme-status-danger)]">{{ agent.error }}</div>
          </div>
          <button
            v-if="!presetIds.has(agent.id)"
            type="button"
            class="rounded p-1 text-[var(--theme-text-muted)] hover:bg-[var(--theme-list-row-hover-bg)] hover:text-[var(--theme-status-danger)]"
            :title="$t('statusMonitor.acp.remove')"
            :disabled="removing === agent.id"
            @click="removeAgent(agent.id)"
          >
            <Icon icon="lucide:trash-2" :width="13" :height="13" />
          </button>
          <label class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center">
            <input
              type="checkbox"
              class="peer sr-only"
              :data-acp-toggle="agent.id"
              :checked="agent.enabled"
              :disabled="toggling === agent.id"
              :aria-label="agent.enabled ? $t('statusMonitor.acp.disable') : $t('statusMonitor.acp.enable')"
              @change="toggleAgent(agent.id, !agent.enabled)"
            />
            <span class="absolute inset-0 rounded-full border border-[var(--theme-toggle-track-border)] bg-[var(--theme-toggle-track)] transition peer-checked:bg-[var(--theme-toggle-active-track)] peer-disabled:opacity-50" />
            <span class="relative ml-0.5 h-4 w-4 rounded-full bg-[var(--theme-toggle-thumb)] transition-transform peer-checked:translate-x-4 peer-checked:bg-[var(--theme-toggle-active-thumb)]" />
          </label>
        </div>
      </div>
    </template>
  </div>
</template>
