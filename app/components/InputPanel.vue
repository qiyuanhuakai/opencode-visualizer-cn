<template>
  <div class="input-panel">
    <div class="history-dropdown-wrapper">
      <Dropdown
        ref="historyDropdownRef"
        v-model:open="historyOpen"
        auto-close
        popup-class="history-popup"
        @select="handleHistorySelect"
      >
        <template #trigger><span /></template>
        <template #default>
          <div class="dropdown-list">
            <DropdownItem v-for="(entry, i) in userHistory" :key="i" :value="entry">
              <div
                class="history-item"
                :style="{ borderLeftColor: entry.agentColor ? `${entry.agentColor}99` : '#334155' }"
                :title="entry.text"
              >
                <div class="history-item-text">{{ entry.text }}</div>
              </div>
            </DropdownItem>
          </div>
        </template>
      </Dropdown>
    </div>
    <div class="input-message" :style="inputMessageStyle">
      <textarea
        ref="textareaRef"
        v-model="messageValue"
        class="input-textarea"
        :disabled="false"
        placeholder="Send a message..."
        @keydown="handleKeydown"
        @paste="handlePaste"
        @drop="handleDrop"
        @dragover.prevent
        @dragenter.prevent
      ></textarea>
      <input
        ref="fileInputRef"
        class="file-input"
        type="file"
        :accept="acceptMime"
        multiple
        @change="handleFileChange"
      />
      <div v-if="attachments.length > 0" class="attachment-list">
        <div v-for="item in attachments" :key="item.id" class="attachment-item">
          <img
            v-if="item.mime.startsWith('image/')"
            class="attachment-thumb clickable"
            :src="item.dataUrl"
            :alt="item.filename"
            @click="$emit('open-image', { url: item.dataUrl, filename: item.filename })"
          />
          <div class="attachment-meta">
            <div class="attachment-name">{{ item.filename }}</div>
            <div class="attachment-type">{{ item.mime }}</div>
          </div>
          <button
            type="button"
            class="attachment-remove"
            @click="$emit('remove-attachment', item.id)"
          >
            <Icon icon="lucide:x" :width="12" :height="12" />
          </button>
        </div>
      </div>
      <div v-if="commandPopupOpen" class="command-popup">
        <div
          v-for="(command, index) in commandMatches"
          :key="command.name"
          class="command-item"
          :class="{ 'is-active': index === activeCommandIndex }"
          @mousedown.prevent="selectCommand(command.name)"
        >
          <div class="command-name">/{{ command.name }}</div>
          <div v-if="command.description" class="command-desc">{{ command.description }}</div>
        </div>
      </div>
    </div>
    <div class="input-toolbar">
      <div class="input-selects">
        <div class="input-field compact">
          <Dropdown
            v-model="modeValue"
            :label="selectedAgentLabel"
            :placeholder="hasAgentOptions ? 'Select agent' : 'Loading agents...'"
            :disabled="props.disabled || !hasAgentOptions"
            button-class="input-control input-dropdown-button"
            :button-style="agentButtonStyle"
            popup-class="input-dropdown-popup"
            auto-close
            title="Agent (Tab)"
            @update:open="handleModelDropdownOpenChange"
          >
            <template #label>
              <span class="ui-dropdown-label" :style="agentButtonLabelStyle">{{
                selectedAgentLabel
              }}</span>
            </template>
            <template #default>
              <div class="dropdown-list">
                <div v-if="!hasAgentOptions" class="dropdown-empty">Loading agents...</div>
                <DropdownItem v-for="agent in agentOptions" :key="agent.id" :value="agent.id">
                  <div class="agent-dropdown-item">
                    <span class="agent-dropdown-name" :style="agentOptionNameStyle(agent)">
                      {{ agent.label }}
                    </span>
                    <span v-if="agent.description" class="agent-dropdown-description">
                      {{ agent.description }}
                    </span>
                  </div>
                </DropdownItem>
              </div>
            </template>
          </Dropdown>
        </div>
        <div class="input-field compact">
          <div ref="modelDropdownRef" class="input-dropdown-root">
            <Dropdown
              v-model="modelValue"
              :label="selectedModelDisplayName"
              :placeholder="hasModelOptions ? 'Select model' : 'Loading models...'"
              :disabled="props.disabled || !hasModelOptions"
              button-class="input-control input-dropdown-button"
              :button-style="agentButtonStyle"
              popup-class="input-dropdown-popup"
              auto-close
              title="Model (Ctrl-M)"
              @update:open="handleModelDropdownOpenChange"
            >
              <template #label>
                <div class="model-button-label">
                  <span class="model-button-name">{{ selectedModelDisplayName }}</span>
                  <span v-if="selectedModelPath" class="model-button-path">{{
                    selectedModelPath
                  }}</span>
                </div>
              </template>
              <template #default>
                <div class="dropdown-list">
                  <div v-if="!hasModelOptions" class="dropdown-empty">Loading models...</div>
                  <template v-for="group in groupedModelOptions" :key="group.providerID">
                    <div class="input-dropdown-group-label">{{ group.label }}</div>
                    <DropdownItem v-for="model in group.models" :key="model.id" :value="model.id">
                      <div class="model-dropdown-item">
                        <span class="model-dropdown-name">{{ model.displayName }}</span>
                        <span class="model-dropdown-path"
                          >{{ model.providerID }}/{{ model.modelID }}</span
                        >
                      </div>
                    </DropdownItem>
                  </template>
                </div>
              </template>
            </Dropdown>
          </div>
        </div>
        <div class="input-field compact">
           <Dropdown
            v-model="thinkingKeyValue"
            :label="selectedThinkingLabel"
            :placeholder="hasThinkingOptions ? 'Select variant' : 'Loading...'"
            :disabled="props.disabled || !hasThinkingOptions"
            button-class="input-control input-dropdown-button"
            :button-style="agentButtonStyle"
            popup-class="input-dropdown-popup"
             auto-close
             title="Variant (Ctrl-, / Ctrl-.)"
             @update:open="handleModelDropdownOpenChange"
           >
            <template #default>
              <div class="dropdown-list">
                <div v-if="!hasThinkingOptions" class="dropdown-empty">Loading...</div>
                <DropdownItem v-for="option in thinkingChoices" :key="option.key" :value="option.key">
                  <span class="dropdown-item-label">{{ option.label }}</span>
                </DropdownItem>
              </div>
            </template>
          </Dropdown>
        </div>

      </div>
      <button
        type="button"
        class="input-button attach-button"
        :disabled="props.disabled || props.canAttach === false"
        title="Attach"
        @click="triggerFileInput"
      >
        <Icon icon="lucide:paperclip" :width="16" :height="16" />
      </button>
      <button
        v-if="isThinking"
        type="button"
        class="input-button stop send-button"
        :disabled="props.disabled || !canAbort"
        title="Stop (ESC x2)"
        @click="$emit('abort')"
      >
        <Icon icon="lucide:circle-x" :width="16" :height="16" />
      </button>
      <button
        v-else
        type="button"
        class="input-button primary send-button"
        :disabled="props.disabled || !canSend"
        :title="sendTooltip"
        @click="$emit('send')"
      >
        <Icon icon="lucide:send" :width="16" :height="16" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import Dropdown from './Dropdown.vue';
import DropdownItem from './Dropdown/Item.vue';
import { useMessages } from '../composables/useMessages';
import { useSettings } from '../composables/useSettings';
type ModelOption = {
  id: string;
  modelID: string;
  label: string;
  displayName: string;
  providerID?: string;
  providerLabel?: string;
};
type CommandOption = { name: string; description?: string; hints?: string[] };
type AgentOption = { id: string; label: string; description?: string; color?: string };
type ThinkingChoice = { key: string; value: string | undefined; label: string };

const props = defineProps<{
  messageInput: string;
  canSend: boolean;
  selectedMode: string;
  agentOptions: AgentOption[];
  hasAgentOptions: boolean;
  selectedModel: string;
  selectedThinking: string | undefined;
  modelOptions: ModelOption[];
  thinkingOptions: Array<string | undefined>;
  hasModelOptions: boolean;
  hasThinkingOptions: boolean;
  canAttach?: boolean;
  isThinking: boolean;
  canAbort: boolean;
  commands: CommandOption[];
  attachments: Array<{ id: string; filename: string; mime: string; dataUrl: string }>;
  agentColor?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (event: 'update:message-input', value: string): void;
  (event: 'update:selected-mode', value: string): void;
  (event: 'update:selected-model', value: string): void;
  (event: 'update:selected-thinking', value: string | undefined): void;
  (event: 'send'): void;
  (event: 'abort'): void;
  (event: 'add-attachments', files: File[]): void;
  (event: 'remove-attachment', id: string): void;
  (event: 'open-image', payload: { url: string; filename: string }): void;
}>();

const messageValue = computed({
  get: () => props.messageInput,
  set: (value) => emit('update:message-input', value),
});

const textareaRef = ref<HTMLTextAreaElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const modelDropdownRef = ref<HTMLElement | null>(null);
const activeCommandIndex = ref(0);
const acceptMime = 'image/png,image/jpeg,image/gif,image/webp';

const { enterToSend } = useSettings();

// --- Input history navigation ---
const { roots: messageRoots, getTextContent } = useMessages();
const historyOpen = ref(false);

const historyDropdownRef = ref<InstanceType<typeof Dropdown> | null>(null);

type HistoryEntry = { text: string; agent?: string; agentColor?: string };

const userHistory = computed(() => {
  const result: HistoryEntry[] = [];
  for (const msg of messageRoots.value) {
    if (msg.role !== 'user') continue;
    const text = getTextContent(msg.id);
    if (!text) continue;
    const agent = 'agent' in msg ? (msg.agent as string | undefined) : undefined;
    const agentOption = agent ? props.agentOptions.find((a) => a.id === agent) : undefined;
    result.push({ text, agent, agentColor: agentOption?.color });
  }
  return result;
});

function handleHistorySelect(entry: HistoryEntry) {
  messageValue.value = entry.text;
  if (entry.agent && props.agentOptions.some((a) => a.id === entry.agent)) {
    emit('update:selected-mode', entry.agent);
  }
  nextTick(() => textareaRef.value?.focus());
}

watch(historyOpen, (open) => {
  if (open) {
    // Highlight the last (most recent) item and scroll to it
    nextTick(() => historyDropdownRef.value?.moveHighlight('up'));
  } else {
    nextTick(() => textareaRef.value?.focus());
  }
});



const sendTooltip = computed(() =>
  enterToSend.value ? 'Ctrl-Enter / Enter to send' : 'Ctrl-Enter to send',
);

const slashQuery = computed(() => {
  const value = messageValue.value;
  if (!value.startsWith('/')) return '';
  const trimmed = value.slice(1);
  const match = trimmed.match(/^(\S*)/);
  return match?.[1] ?? '';
});

const commandMatches = computed(() => {
  if (!messageValue.value.startsWith('/')) return [];
  if (/\s/.test(messageValue.value.slice(1))) return [];
  const query = slashQuery.value.trim().toLowerCase();
  const list = props.commands ?? [];
  const matches = list.filter((command) => command.name.toLowerCase().startsWith(query));
  const limit = 8;
  return matches.slice(0, limit);
});

const commandPopupOpen = computed(() => commandMatches.value.length > 0);

watch(() => props.disabled, (disabled, prev) => {
  if (prev && !disabled) {
    nextTick(() => {
      textareaRef.value?.focus();
    });
  }
});

watch(slashQuery, () => {
  activeCommandIndex.value = 0;
});

watch(commandMatches, (matches) => {
  if (matches.length === 0) {
    activeCommandIndex.value = 0;
    return;
  }
  if (activeCommandIndex.value >= matches.length) {
    activeCommandIndex.value = matches.length - 1;
  }
});

function applyCommandSelection(name: string) {
  const current = messageValue.value;
  const rest = current.replace(/^\/\S*/, '');
  const nextRest = rest.length > 0 ? rest : ' ';
  messageValue.value = `/${name}${nextRest}`;
  nextTick(() => {
    textareaRef.value?.focus();
  });
}

function selectCommand(name: string) {
  applyCommandSelection(name);
}

function selectActiveCommand() {
  const match = commandMatches.value[activeCommandIndex.value];
  if (!match) return;
  applyCommandSelection(match.name);
}

function extractSlashCommand(value: string) {
  if (!value.startsWith('/')) return '';
  const trimmed = value.slice(1);
  const match = trimmed.match(/^(\S+)/);
  return match?.[1] ?? '';
}

function hasMatchingCommand(name: string) {
  if (!name) return false;
  return (props.commands ?? []).some(
    (command) => command.name.toLowerCase() === name.toLowerCase(),
  );
}

function nextCyclicIndex(current: string | undefined, options: Array<string | undefined>) {
  if (options.length === 0) return -1;
  const index = options.indexOf(current);
  if (index < 0) return 0;
  return (index + 1) % options.length;
}

function prevCyclicIndex(current: string | undefined, options: Array<string | undefined>) {
  if (options.length === 0) return -1;
  const index = options.indexOf(current);
  if (index < 0) return options.length - 1;
  return (index - 1 + options.length) % options.length;
}

function cycleAgent(direction: 'next' | 'prev') {
  if (!props.hasAgentOptions) return false;
  const options = (props.agentOptions ?? []).map((option) => option.id);
  const nextIndex =
    direction === 'next'
      ? nextCyclicIndex(props.selectedMode, options)
      : prevCyclicIndex(props.selectedMode, options);
  if (nextIndex < 0) return false;
  emit('update:selected-mode', options[nextIndex]!);
  return true;
}

function cycleVariant(direction: 'next' | 'prev') {
  if (!props.hasThinkingOptions) return false;
  const options = props.thinkingOptions ?? [];
  const nextIndex =
    direction === 'next'
      ? nextCyclicIndex(props.selectedThinking, options)
      : prevCyclicIndex(props.selectedThinking, options);
  if (nextIndex < 0) return false;
  emit('update:selected-thinking', options[nextIndex]!);
  return true;
}

function openModelPicker() {
  if (!props.hasModelOptions) return false;
  const root = modelDropdownRef.value;
  if (!root) return false;
  const button = root.querySelector('button');
  if (!(button instanceof HTMLButtonElement)) return false;
  button.focus();
  button.click();
  return true;
}

function handleModelDropdownOpenChange(open: boolean) {
  if (!open) {
    nextTick(() => {
      textareaRef.value?.focus();
    });
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (commandPopupOpen.value) {
    const total = commandMatches.value.length;
    if (total === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeCommandIndex.value = (activeCommandIndex.value + 1) % total;
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeCommandIndex.value = (activeCommandIndex.value - 1 + total) % total;
      return;
    }
    if (
      event.key === 'Tab' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      selectActiveCommand();
      return;
    }
    if (
      event.key === 'Enter' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      selectActiveCommand();
    }
    return;
  }
  // --- Input history: open dropdown when ArrowUp on empty input ---
  if (
    event.key === 'ArrowUp' &&
    !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
    messageValue.value === '' &&
    userHistory.value.length > 0
  ) {
    event.preventDefault();
    historyOpen.value = true;
    return;
  }
  if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const direction: 'next' | 'prev' = event.shiftKey ? 'prev' : 'next';
    if (!cycleAgent(direction)) return;
    event.preventDefault();
    return;
  }
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === '.') {
    if (!cycleVariant('next')) return;
    event.preventDefault();
    return;
  }
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === ',') {
    if (!cycleVariant('prev')) return;
    event.preventDefault();
    return;
  }
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'm') {
    if (!openModelPicker()) return;
    event.preventDefault();
    return;
  }
  // Ctrl+Enter: always send
  if (event.key === 'Enter' && event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    emit('send');
    return;
  }
  // Enter (no modifiers): send or newline depending on setting
  if (
    event.key === 'Enter' &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey
  ) {
    if (enterToSend.value) {
      event.preventDefault();
      emit('send');
      return;
    }
    // Default: send only for recognized slash commands
    if (messageValue.value.startsWith('/')) {
      const commandName = extractSlashCommand(messageValue.value);
      if (hasMatchingCommand(commandName)) {
        event.preventDefault();
        emit('send');
      }
    }
  }
}

function triggerFileInput() {
  fileInputRef.value?.click();
}

function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement | null;
  const files = input?.files ? Array.from(input.files) : [];
  if (files.length > 0) emit('add-attachments', files);
  if (input) input.value = '';
  nextTick(() => {
    textareaRef.value?.focus();
  });
}

function handlePaste(event: ClipboardEvent) {
  const items = event.clipboardData?.items ? Array.from(event.clipboardData.items) : [];
  if (items.length === 0) return;
  const files = items
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  if (files.length === 0) return;
  event.preventDefault();
  emit('add-attachments', files);
}

function handleDrop(event: DragEvent) {
  const files = event.dataTransfer?.files ? Array.from(event.dataTransfer.files) : [];
  if (files.length === 0) return;
  event.preventDefault();
  emit('add-attachments', files);
}

const modeValue = computed({
  get: () => props.selectedMode,
  set: (value) => emit('update:selected-mode', value),
});

const modelValue = computed({
  get: () => props.selectedModel,
  set: (value) => emit('update:selected-model', value),
});

const thinkingValue = computed({
  get: () => props.selectedThinking,
  set: (value) => emit('update:selected-thinking', value),
});

const selectedAgent = computed(() =>
  (props.agentOptions ?? []).find((option) => option.id === props.selectedMode),
);

const selectedAgentLabel = computed(() => selectedAgent.value?.label ?? '');

const agentButtonStyle = computed(() => {
  const color = selectedAgent.value?.color;
  if (!color) return undefined;
  if (color.startsWith('#') && color.length === 7) {
    return { borderColor: `${color}80` };
  }
  return { borderColor: color };
});

const agentButtonLabelStyle = computed(() => {
  const color = selectedAgent.value?.color;
  return color ? { color } : undefined;
});

function agentOptionNameStyle(agent: AgentOption) {
  return agent.color ? { color: agent.color } : undefined;
}

const selectedModelOption = computed(() =>
  (props.modelOptions ?? []).find((option) => option.id === props.selectedModel),
);

const selectedModelDisplayName = computed(() => selectedModelOption.value?.displayName ?? '');

const selectedModelPath = computed(() => {
  const opt = selectedModelOption.value;
  if (!opt) return '';
  return `${opt.providerID ?? ''}/${opt.modelID}`;
});

const thinkingChoices = computed<ThinkingChoice[]>(() =>
  (props.thinkingOptions ?? []).map((option) => ({
    key: option ?? '__default',
    value: option,
    label: option === undefined ? '<default>' : option,
  })),
);

const selectedThinkingChoice = computed<ThinkingChoice | undefined>(() =>
  thinkingChoices.value.find((option) => option.value === props.selectedThinking),
);

const thinkingKeyValue = computed({
  get: () => selectedThinkingChoice.value?.key,
  set: (key: string) => {
    const choice = thinkingChoices.value.find((c) => c.key === key);
    emit('update:selected-thinking', choice?.value);
  },
});

const selectedThinkingLabel = computed(() => selectedThinkingChoice.value?.label ?? '');

const groupedModelOptions = computed(() => {
  const grouped = new Map<string, { providerID: string; label: string; models: ModelOption[] }>();
  const models = (props.modelOptions ?? []).map((model) => ({
    ...model,
    displayName: model.displayName || model.label,
  }));
  models.forEach((model) => {
    const providerID = model.providerID?.trim() || 'unknown';
    const providerLabel = model.providerLabel?.trim() || providerID;
    const existing = grouped.get(providerID);
    if (existing) {
      existing.models.push(model);
      return;
    }
    grouped.set(providerID, {
      providerID,
      label: providerLabel,
      models: [model],
    });
  });
  return Array.from(grouped.values());
});

function focus() {
  textareaRef.value?.focus();
}

defineExpose({ focus });

const inputMessageStyle = computed(() => {
  if (!props.agentColor) return { borderColor: '#334155' };
  const color = props.agentColor;
  // If it is 7 chars (#RRGGBB), append alpha for border transparency
  if (color.startsWith('#') && color.length === 7) {
    return { borderColor: `${color}A6` }; // ~0.65 alpha
  }
  return { borderColor: color };
});
</script>

<style scoped>
.input-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  padding: 10px;
  background: rgba(15, 23, 42, 0.92);
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(2, 6, 23, 0.45);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
}

.input-message {
  width: 100%;
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  overflow: visible;
  background: #0b1320;
  border: 1px solid #334155;
  border-radius: 8px;
  box-sizing: border-box;
}

.input-message:has(.input-textarea:disabled) {
  opacity: 0.6;
}

.input-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.input-selects {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.input-selects .input-control {
  height: 32px;
}



.input-dropdown-root {
  width: 100%;
}

.input-field {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.input-field.compact {
  flex: 1 1 160px;
  min-width: 160px;
}

:deep(.input-control) {
  width: 100%;
  background: #0b1320;
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  box-sizing: border-box;
}

:deep(.input-control):focus-visible {
  outline: none;
}

:deep(.input-dropdown-button) {
  height: 32px;
}

:deep(.input-dropdown-popup) {
  max-height: 280px;
  outline: none;
}

.dropdown-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dropdown-empty {
  padding: 6px 8px;
  font-size: 12px;
  color: #94a3b8;
}

.dropdown-item-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.input-dropdown-group-label {
  font-size: 10px;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 6px 8px 2px;
}

.agent-dropdown-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  min-width: 0;
}

.agent-dropdown-name {
  font-size: 12px;
  color: #e2e8f0;
  line-height: 1.2;
}

.agent-dropdown-description {
  font-size: 10px;
  color: #94a3b8;
  line-height: 1.2;
}

.model-button-label {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  line-height: 1.15;
  text-align: left;
}

.model-button-name {
  font-size: 12px;
  color: #e2e8f0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-button-path {
  font-size: 9px;
  color: #94a3b8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-dropdown-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  min-width: 0;
}

.model-dropdown-name {
  font-size: 12px;
  color: #e2e8f0;
  line-height: 1.2;
}

.model-dropdown-path {
  font-size: 10px;
  color: #94a3b8;
  line-height: 1.2;
}

.input-textarea:disabled {
  opacity: 0.6;
}

.input-textarea {
  resize: none;
  min-height: 1em;
  font-size: 13px;
  line-height: 1.2;
  display: block;
  width: 100%;
  flex: 1 1 auto;
  height: auto;
  position: relative;
  z-index: 1;
  border: none;
  border-radius: inherit;
  background: transparent;
  color: #e2e8f0;
  outline: none;
  padding: 8px;
  box-sizing: border-box;
  font-family: inherit;
}

.file-input {
  display: none;
}

.attachment-list {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 6px;
  width: 100%;
  padding: 6px 8px 8px;
  border-top: 1px solid #1e293b;
  box-sizing: border-box;
  max-height: 45%;
  overflow: auto;
  flex: 0 0 auto;
}

.attachment-item {
  display: flex;
  align-items: center;
  flex: 0 1 250px;
  max-width: 250px;
  min-width: 0;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid #1e293b;
  background: rgba(2, 6, 23, 0.6);
  box-sizing: border-box;
}

.attachment-thumb {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  border: 1px solid #334155;
  object-fit: cover;
  background: #0b1320;
}

.attachment-thumb.clickable {
  cursor: pointer;
}

.attachment-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
}

.attachment-name {
  font-size: 12px;
  color: #e2e8f0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.attachment-type {
  font-size: 10px;
  color: #94a3b8;
}

.attachment-remove {
  background: #1e293b;
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 6px;
  padding: 4px;
  font-size: 10px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.command-popup {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 8px);
  background: rgba(2, 6, 23, 0.98);
  border: 1px solid #334155;
  border-radius: 10px;
  padding: 6px;
  box-shadow: 0 12px 24px rgba(2, 6, 23, 0.45);
  max-height: 220px;
  overflow: auto;
  z-index: 5;
}

.command-item {
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.command-item.is-active {
  background: rgba(59, 130, 246, 0.2);
  border: 1px solid rgba(59, 130, 246, 0.45);
}

.command-name {
  font-size: 12px;
  color: #e2e8f0;
}

.command-desc {
  font-size: 11px;
  color: #94a3b8;
}

.history-dropdown-wrapper {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 0;
  overflow: visible;
  pointer-events: none;
}

.history-dropdown-wrapper :deep(.ui-dropdown-menu) {
  pointer-events: auto;
}

:deep(.history-popup) {
  /* Open upward instead of downward */
  top: auto;
  bottom: anchor(top);
  margin-top: 0;
  margin-bottom: 6px;
  max-height: 50vh;
  overflow: auto;
  /* Match input panel background */
  background: rgba(15, 23, 42, 0.92);
  border: 1px solid #334155;
  outline: none;
  box-shadow: 0 -8px 24px rgba(2, 6, 23, 0.5);
  box-sizing: border-box;
}

:deep(.history-popup) .ui-dropdown-item {
  /* Match thread-block style */
  background: rgba(2, 6, 23, 0.6);
  border: 1px solid #1e293b;
  border-radius: 10px;
  padding: 8px;
}

:deep(.history-popup) .ui-dropdown-item + .ui-dropdown-item {
  margin-top: 4px;
}

:deep(.history-popup) .ui-dropdown-item[aria-selected='true'],
:deep(.history-popup) .ui-dropdown-item:hover {
  background: rgba(30, 41, 59, 0.7);
  border-color: #475569;
}

.history-item {
  border-left: 3px solid #334155;
  padding-left: 8px;
  width: 100%;
}

.history-item-text {
  font-size: 12px;
  color: #e2e8f0;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
  white-space: pre-wrap;
}

.input-button {
  background: #1e293b;
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 8px;
  width: 32px;
  height: 32px;
  padding: 0;
  font-size: 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.input-button:disabled {
  opacity: 0.6;
  cursor: default;
}

.send-button {
  height: 32px;
}

.input-button.primary {
  background: #2563eb;
  border-color: #1d4ed8;
}

.input-button.stop {
  background: #dc2626;
  border-color: #b91c1c;
  color: #fef2f2;
}

.send-button {
  margin-left: auto;
}

.attach-button {
  height: 32px;
}
</style>
