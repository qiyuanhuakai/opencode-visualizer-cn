<template>
  <div class="control-panel">
    <div class="control-message">
      <textarea
        ref="textareaRef"
        v-model="messageValue"
        class="control-input control-textarea"
        placeholder="Send a message..."
        @keydown="handleKeydown"
        @keydown.enter.ctrl.prevent="$emit('send')"
      ></textarea>
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
    <div class="control-toolbar">
      <div class="control-selects">
        <div class="control-field compact">
          <select
            id="mode-select"
            v-model="modeValue"
            class="control-input"
            :disabled="!hasAgentOptions"
            aria-label="Agent"
            title="Agent"
          >
            <option v-if="!hasAgentOptions" value="">Loading agents...</option>
            <option v-for="agent in agentOptions" :key="agent.id" :value="agent.id">
              {{ agent.label }}
            </option>
          </select>
        </div>
        <div class="control-field compact">
          <select
            id="model-select"
            v-model="modelValue"
            class="control-input"
            :disabled="!hasModelOptions"
            aria-label="Model"
            title="Model"
          >
            <option v-if="!hasModelOptions" value="">Loading models...</option>
            <option v-for="model in modelOptions" :key="model.id" :value="model.id">
              {{ model.label }}
            </option>
          </select>
        </div>
        <div class="control-field compact">
          <select
            id="thinking-select"
            v-model="thinkingValue"
            class="control-input"
            :disabled="!hasThinkingOptions"
            aria-label="Thinking"
            title="Thinking"
          >
            <option v-if="!hasThinkingOptions" value="">Loading...</option>
            <option v-for="option in thinkingOptions" :key="option" :value="option">
              {{ option }}
            </option>
          </select>
        </div>
      </div>
      <button
        v-if="isThinking"
        type="button"
        class="control-button stop send-button"
        :disabled="!canAbort"
        @click="$emit('abort')"
      >
        STOP
      </button>
      <button
        v-else
        type="button"
        class="control-button primary send-button"
        :disabled="!canSend"
        @click="$emit('send')"
      >
        Send
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
type ModelOption = { id: string; label: string };
type CommandOption = { name: string; description?: string; hints?: string[] };

const props = defineProps<{
  messageInput: string;
  canSend: boolean;
  selectedMode: string;
  agentOptions: Array<{ id: string; label: string }>;
  hasAgentOptions: boolean;
  selectedModel: string;
  selectedThinking: string;
  modelOptions: ModelOption[];
  thinkingOptions: string[];
  hasModelOptions: boolean;
  hasThinkingOptions: boolean;
  isThinking: boolean;
  canAbort: boolean;
  commands: CommandOption[];
}>();

const emit = defineEmits<{
  (event: 'update:message-input', value: string): void;
  (event: 'update:selected-mode', value: string): void;
  (event: 'update:selected-model', value: string): void;
  (event: 'update:selected-thinking', value: string): void;
  (event: 'send'): void;
  (event: 'abort'): void;
}>();

const messageValue = computed({
  get: () => props.messageInput,
  set: (value) => emit('update:message-input', value),
});

const textareaRef = ref<HTMLTextAreaElement | null>(null);
const activeCommandIndex = ref(0);

const slashQuery = computed(() => {
  const value = messageValue.value;
  if (!value.startsWith('/')) return '';
  const trimmed = value.slice(1);
  const match = trimmed.match(/^(\S*)/);
  return match?.[1] ?? '';
});

const commandMatches = computed(() => {
  if (!messageValue.value.startsWith('/')) return [];
  const query = slashQuery.value.trim().toLowerCase();
  const list = props.commands ?? [];
  const matches = list.filter((command) =>
    command.name.toLowerCase().startsWith(query),
  );
  const limit = 8;
  return matches.slice(0, limit);
});

const commandPopupOpen = computed(() => commandMatches.value.length > 0);

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
  messageValue.value = `/${name}${rest}`;
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

function handleKeydown(event: KeyboardEvent) {
  if (!commandPopupOpen.value) return;
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
  if (event.key === 'Tab') {
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
</script>

<style scoped>
.control-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  box-sizing: border-box;
  padding: 10px;
  background: rgba(15, 23, 42, 0.92);
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(2, 6, 23, 0.45);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
}

.control-message {
  width: 100%;
  position: relative;
}

.control-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.control-selects {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.control-selects .control-input {
  height: 32px;
}

.control-field {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.control-field.compact {
  flex: 1 1 160px;
  min-width: 160px;
}

.control-input {
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

.control-input:focus-visible {
  outline: none;
}

.control-textarea {
  resize: none;
  min-height: 96px;
  font-size: 13px;
  line-height: 1.35;
  display: block;
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

.control-button {
  background: #1e293b;
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 6px 12px;
  height: 32px;
  font-size: 12px;
  cursor: pointer;
}

.send-button {
  height: 32px;
}

.control-button.primary {
  background: #2563eb;
  border-color: #1d4ed8;
}

.control-button.stop {
  background: #dc2626;
  border-color: #b91c1c;
  color: #fef2f2;
}

.send-button {
  margin-left: auto;
}
</style>
