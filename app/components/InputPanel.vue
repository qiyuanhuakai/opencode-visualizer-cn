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
            <DropdownItem
              v-for="(entry, i) in userHistory"
              :key="`${entry.text}:${entry.agent}:${entry.model}:${entry.variant}:${i}`"
              :value="entry"
            >
              <div class="history-item" :style="historyEntryStyle(entry)" :title="entry.text">
                <div class="history-item-text">{{ entry.text }}</div>
                <div v-if="hasHistoryEntryTarget(entry)" class="history-item-target">
                  <span
                    v-if="entry.agent"
                    class="history-target-agent"
                    :style="historyEntryAgentStyle(entry)"
                  >
                    {{ entry.agent }}
                  </span>
                  <span v-if="historyEntryModelDisplayName(entry)" class="history-target-model">
                    {{ historyEntryModelDisplayName(entry) }}
                  </span>
                  <span v-if="historyEntryProviderLabel(entry)" class="history-target-provider">
                    {{ historyEntryProviderLabel(entry) }}
                  </span>
                  <span v-if="entry.variant" class="history-target-separator">&middot;</span>
                  <span v-if="entry.variant" class="history-target-variant">{{
                    entry.variant
                  }}</span>
                </div>
              </div>
              <button
                type="button"
                class="history-action-button"
                :class="{ 'is-favorited': isFavorite(entry) }"
                :title="$t('inputPanel.bookmark')"
                @click.stop="addFavorite(entry)"
              >
                <Icon icon="lucide:bookmark" :width="14" :height="14" />
              </button>
            </DropdownItem>
          </div>
        </template>
      </Dropdown>
      <Dropdown
        ref="favoritesDropdownRef"
        v-model:open="favoritesOpen"
        auto-close
        popup-class="history-popup"
        @select="handleFavoriteSelect"
      >
        <template #trigger><span /></template>
        <template #default>
          <div class="dropdown-list">
            <DropdownItem
              v-for="(entry, i) in favorites"
              :key="`${entry.text}:${entry.agent}:${entry.model}:${entry.variant}:${i}`"
              :value="entry"
            >
              <div class="history-item" :style="historyEntryStyle(entry)" :title="entry.text">
                <div class="history-item-text">{{ entry.text }}</div>
                <div v-if="hasHistoryEntryTarget(entry)" class="history-item-target">
                  <span
                    v-if="entry.agent"
                    class="history-target-agent"
                    :style="historyEntryAgentStyle(entry)"
                  >
                    {{ entry.agent }}
                  </span>
                  <span v-if="historyEntryModelDisplayName(entry)" class="history-target-model">
                    {{ historyEntryModelDisplayName(entry) }}
                  </span>
                  <span v-if="historyEntryProviderLabel(entry)" class="history-target-provider">
                    {{ historyEntryProviderLabel(entry) }}
                  </span>
                  <span v-if="entry.variant" class="history-target-separator">&middot;</span>
                  <span v-if="entry.variant" class="history-target-variant">{{
                    entry.variant
                  }}</span>
                </div>
              </div>
              <button
                type="button"
                class="history-action-button remove"
                :title="$t('inputPanel.removeFromFavorites')"
                @click.stop="confirmRemoveFavorite(i)"
              >
                <Icon icon="lucide:trash-2" :width="14" :height="14" />
              </button>
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
        :placeholder="$t('inputPanel.placeholder')"
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
      <div class="command-dropdown-wrapper">
        <Dropdown
          ref="commandDropdownRef"
          :open="commandPopupOpen"
          :auto-close="false"
          :auto-focus="false"
          :auto-highlight="true"
          popup-class="input-dropdown-popup command-popup"
          @select="handleCommandSelect"
        >
          <template #trigger><span /></template>
          <template #default>
            <div class="dropdown-list">
              <DropdownItem
                v-for="command in commandMatches"
                :key="command.name"
                :value="command.name"
              >
                <div class="command-dropdown-item">
                  <div class="command-name">/{{ command.name }}</div>
                  <div v-if="command.description" class="command-desc">
                    {{ command.description }}
                  </div>
                </div>
              </DropdownItem>
            </div>
          </template>
        </Dropdown>
      </div>
      <div class="agent-dropdown-wrapper">
        <Dropdown
          ref="agentDropdownRef"
          :open="agentPopupOpen"
          :auto-close="false"
          :auto-focus="false"
          :auto-highlight="true"
          popup-class="input-dropdown-popup agent-popup"
          @select="handleAgentSelect"
        >
          <template #trigger><span /></template>
          <template #default>
            <div class="dropdown-list">
              <DropdownItem
                v-for="agent in agentMatches"
                :key="agent.id"
                :value="agent.id"
              >
                <div class="agent-dropdown-item">
                  <div class="agent-popup-name">
                    @{{ agent.label }}
                    <span v-if="agent.isSubagent" class="agent-mode-badge">[Subagent]</span>
                  </div>
                  <div v-if="agent.description" class="agent-popup-description">
                    {{ agent.description }}
                  </div>
                </div>
              </DropdownItem>
            </div>
          </template>
        </Dropdown>
      </div>
      <div class="input-toolbar">
        <div class="input-selects">
          <div class="input-field compact">
            <Dropdown
              v-model="modeValue"
              :placeholder="hasAgentOptions ? $t('inputPanel.selectAgent') : $t('inputPanel.loadingAgents')"
              :disabled="props.disabled || !hasAgentOptions"
              button-class="input-control input-dropdown-button"
              popup-class="input-dropdown-popup"
              auto-close
              :title="$t('inputPanel.agentTitle')"
              @update:open="handleModelDropdownOpenChange"
            >
              <template #value="{ value: id }">
                <span :style="agentValueStyle(id)">{{ findAgent(id)?.label }}</span>
              </template>
              <template #default>
                <div class="dropdown-list">
                  <div v-if="!hasAgentOptions" class="dropdown-empty">{{ $t('inputPanel.loadingAgents') }}</div>
                  <DropdownItem v-for="agent in agentOptions" :key="agent.id" :value="agent.id">
                    <div class="agent-dropdown-item">
                      <span class="agent-dropdown-name" :style="agentOptionNameStyle(agent)">
                        {{ agent.label }}
                      </span>
                      <span
                        v-if="agent.description"
                        class="agent-dropdown-description"
                        :title="agent.description"
                      >
                        {{ agent.description }}
                      </span>
                    </div>
                  </DropdownItem>
                </div>
              </template>
            </Dropdown>
          </div>
        </div>
        <div class="input-field compact">
          <div ref="modelDropdownRef" class="input-dropdown-root">
            <Dropdown
              v-model="modelValue"
              :placeholder="hasModelOptions ? $t('inputPanel.selectModel') : $t('inputPanel.loadingModels')"
              :disabled="props.disabled || !hasModelOptions"
              button-class="input-control input-dropdown-button"
              popup-class="input-dropdown-popup"
              auto-close
              :title="$t('inputPanel.modelTitle')"
              @update:open="handleModelDropdownOpenChange"
            >
              <template #value="{ value: id }">
                <div class="model-button-label">
                  <span
                    v-if="findModelOption(id)?.providerLabel ?? findModelOption(id)?.providerID"
                    class="model-button-provider"
                    >{{
                      findModelOption(id)?.providerLabel ?? findModelOption(id)?.providerID
                    }}</span
                  >
                  <span class="model-button-name">{{ findModelOption(id)?.displayName }}</span>
                </div>
              </template>
              <template #default>
                <div class="model-picker">
                  <DropdownSearch
                    v-model="modelSearchQuery"
                    :placeholder="$t('inputPanel.searchPlaceholder')"
                    class="model-search"
                  />
                  <div class="model-picker-list">
                    <div class="dropdown-list">
                      <div v-if="!hasModelOptions" class="dropdown-empty">{{ $t('inputPanel.loadingModels') }}</div>
                      <div
                        v-else-if="filteredGroupedModelOptions.length === 0"
                        class="dropdown-empty"
                      >
                        No matching models
                      </div>
                      <template
                        v-for="group in filteredGroupedModelOptions"
                        :key="group.providerID"
                      >
                        <DropdownLabel>{{ group.label }}</DropdownLabel>
                        <DropdownItem
                          v-for="model in group.models"
                          :key="model.id"
                          :value="model.id"
                        >
                          <div class="model-dropdown-item">
                            <span class="model-dropdown-name">{{ model.displayName }}</span>
                            <span class="model-dropdown-path"
                              >{{ model.providerID }}/{{ model.modelID }}</span
                            >
                          </div>
                        </DropdownItem>
                      </template>
                    </div>
                  </div>
                </div>
              </template>
            </Dropdown>
          </div>
        </div>
        <div class="input-field compact">
          <Dropdown
            v-model="thinkingKeyValue"
            :placeholder="hasThinkingOptions ? $t('inputPanel.selectVariant') : $t('inputPanel.loading')"
            :disabled="props.disabled || !hasThinkingOptions"
            button-class="input-control input-dropdown-button"
            popup-class="input-dropdown-popup"
            auto-close
              :title="$t('inputPanel.variantTitle')"
            @update:open="handleModelDropdownOpenChange"
          >
            <template #value="{ value: key }">
              <span :style="thinkingValueStyle(key)">{{ findThinkingChoice(key)?.label }}</span>
            </template>
            <template #default>
              <div class="dropdown-list">
                <div v-if="!hasThinkingOptions" class="dropdown-empty">{{ $t('inputPanel.loading') }}</div>
                <DropdownItem
                  v-for="option in thinkingChoices"
                  :key="option.key"
                  :value="option.key"
                >
                  <span class="dropdown-item-label">{{ option.label }}</span>
                </DropdownItem>
              </div>
            </template>
          </Dropdown>
        </div>
        <div class="input-actions">
          <button
            type="button"
            class="input-button suppress-button"
            :class="{ active: suppressAutoWindows }"
            :title="suppressAutoWindows ? $t('inputPanel.autoWindowsSuppressed') : $t('inputPanel.suppressAutoWindows')"
            @click="suppressAutoWindows = !suppressAutoWindows"
          >
            <Icon
              :icon="suppressAutoWindows ? 'lucide:eye-off' : 'lucide:eye'"
              :width="16"
              :height="16"
            />
          </button>
          <button
            type="button"
            class="input-button bookmark-button"
            :title="messageValue.trim() ? $t('inputPanel.bookmarkCurrentInput') : $t('inputPanel.openBookmarks')"
            @click="messageValue.trim() ? bookmarkCurrentInput() : (favoritesOpen = true)"
          >
            <Icon
              :icon="messageValue.trim() ? 'lucide:bookmark-plus' : 'lucide:bookmark'"
              :width="16"
              :height="16"
            />
            <Transition name="bookmark-toast">
              <span v-if="bookmarkToastVisible" class="bookmark-toast">{{ $t('inputPanel.bookmarked') }}</span>
            </Transition>
          </button>
          <button
            type="button"
            class="input-button attach-button"
            :disabled="props.disabled || props.canAttach === false"
            :title="$t('inputPanel.attach')"
            @click="triggerFileInput"
          >
            <Icon icon="lucide:paperclip" :width="16" :height="16" />
          </button>
          <button
            v-if="isThinking"
            type="button"
            class="input-button stop send-button"
            :disabled="props.disabled || !canAbort"
            :title="$t('inputPanel.stop')"
            @click="$emit('abort')"
          >
            <Icon icon="ph:stop-fill" :width="16" :height="16" />
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import Dropdown from './Dropdown.vue';
import DropdownItem from './Dropdown/Item.vue';
import DropdownLabel from './Dropdown/Label.vue';
import DropdownSearch from './Dropdown/Search.vue';
import { useMessages } from '../composables/useMessages';
import { useFavoriteMessages } from '../composables/useFavoriteMessages';
import { getMessageVariant } from '../types/sse';
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
type AgentOption = { id: string; label: string; description?: string; color?: string; isSubagent?: boolean };
type ThinkingChoice = { key: string; value: string | undefined; label: string };

const { t } = useI18n();

const props = defineProps<{
  messageInput: string;
  canSend: boolean;
  selectedMode: string;
  agentOptions: AgentOption[];
  subagentOptions?: AgentOption[];
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
  resolveAgentColor?: (agent?: string) => string;
  disabled?: boolean;
}>();;

const emit = defineEmits<{
  (event: 'update:message-input', value: string): void;
  (event: 'update:selected-mode', value: string): void;
  (event: 'update:selected-model', value: string): void;
  (event: 'update:selected-thinking', value: string | undefined): void;
  (
    event: 'apply-history-entry',
    payload: {
      text: string;
      agent?: string;
      model?: string;
      variant?: string;
    },
  ): void;
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
const modelSearchQuery = ref('');
const acceptMime = 'image/png,image/jpeg,image/gif,image/webp';

const { enterToSend, suppressAutoWindows } = useSettings();

// --- Input history navigation ---
const { roots: messageRoots, getTextContent } = useMessages();
const historyOpen = ref(false);
const favoritesOpen = ref(false);

type DropdownRef = {
  moveHighlight: (direction: 'up' | 'down') => void;
  selectHighlighted: () => boolean;
  clearHighlight: () => void;
};

const historyDropdownRef = ref<DropdownRef | null>(null);
const favoritesDropdownRef = ref<DropdownRef | null>(null);
const commandDropdownRef = ref<DropdownRef | null>(null);
const agentDropdownRef = ref<DropdownRef | null>(null);

type HistoryEntry = {
  text: string;
  agent?: string;
  agentColor?: string;
  model?: string;
  variant?: string;
};

function findAgentOption(id: string | undefined) {
  if (!id) return undefined;
  return props.agentOptions.find((option) => option.id === id);
}

function historyEntryColor(entry: HistoryEntry) {
  return (
    entry.agentColor ||
    props.resolveAgentColor?.(entry.agent) ||
    findAgentOption(entry.agent)?.color
  );
}

function historyEntryStyle(entry: HistoryEntry) {
  const color = historyEntryColor(entry);
  return { borderLeftColor: color ? `${color}99` : '#334155' };
}

function historyEntryAgentStyle(entry: HistoryEntry) {
  const color = historyEntryColor(entry);
  return color ? { color } : undefined;
}

function historyEntryModelDisplayName(entry: HistoryEntry) {
  if (!entry.model) return undefined;
  return findModelOption(entry.model)?.displayName;
}

function historyEntryProviderLabel(entry: HistoryEntry) {
  if (!entry.model) return undefined;
  return findModelOption(entry.model)?.providerLabel;
}

function hasHistoryEntryTarget(entry: HistoryEntry) {
  return Boolean(
    entry.agent ||
    historyEntryModelDisplayName(entry) ||
    historyEntryProviderLabel(entry) ||
    entry.variant,
  );
}

const { favorites, addFavorite, removeFavorite, isFavorite } = useFavoriteMessages();

const userHistory = computed(() => {
  const result: HistoryEntry[] = [];
  for (const msg of messageRoots.value) {
    if (msg.role !== 'user') continue;
    const text = getTextContent(msg.id);
    if (!text) continue;
    const agent = 'agent' in msg ? (msg.agent as string | undefined) : undefined;
    const agentOption = agent ? props.agentOptions.find((a) => a.id === agent) : undefined;
    const resolvedAgentColor = props.resolveAgentColor?.(agent);
    const model = msg.model ? `${msg.model.providerID}/${msg.model.modelID}` : undefined;
    const variant = getMessageVariant(msg);
    result.push({
      text,
      agent,
      agentColor: agentOption?.color || resolvedAgentColor,
      model,
      variant,
    });
  }
  return result;
});

function applyHistoryEntry(entry: HistoryEntry) {
  emit('apply-history-entry', {
    text: entry.text,
    agent: entry.agent,
    model: entry.model,
    variant: entry.variant,
  });
  nextTick(() => textareaRef.value?.focus());
}

const bookmarkToastVisible = ref(false);
let bookmarkToastTimer: ReturnType<typeof setTimeout> | null = null;

function bookmarkCurrentInput() {
  const text = messageValue.value.trim();
  if (!text) return;
  const agent = props.selectedMode || undefined;
  const agentOption = agent ? props.agentOptions.find((a) => a.id === agent) : undefined;
  const resolvedAgentColor = props.resolveAgentColor?.(agent);
  addFavorite({
    text,
    agent,
    agentColor: agentOption?.color || resolvedAgentColor,
    model: props.selectedModel || undefined,
    variant: props.selectedThinking,
  });
  messageValue.value = '';
  // Show toast
  if (bookmarkToastTimer) clearTimeout(bookmarkToastTimer);
  bookmarkToastVisible.value = true;
  bookmarkToastTimer = setTimeout(() => {
    bookmarkToastVisible.value = false;
  }, 1500);
  nextTick(() => textareaRef.value?.focus());
}

function toHistoryEntry(value: unknown): HistoryEntry | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.text !== 'string') return null;
  const entry: HistoryEntry = { text: candidate.text };
  if (typeof candidate.agent === 'string') entry.agent = candidate.agent;
  if (typeof candidate.agentColor === 'string') entry.agentColor = candidate.agentColor;
  if (typeof candidate.model === 'string') entry.model = candidate.model;
  if (typeof candidate.variant === 'string') entry.variant = candidate.variant;
  return entry;
}

function handleHistorySelect(entry: unknown) {
  const value = toHistoryEntry(entry);
  if (!value) return;
  applyHistoryEntry(value);
}

function handleFavoriteSelect(entry: unknown) {
  const value = toHistoryEntry(entry);
  if (!value) return;
  applyHistoryEntry(value);
}

function confirmRemoveFavorite(index: number) {
  if (!window.confirm(t('inputPanel.removeFromFavoritesConfirm'))) return;
  removeFavorite(index);
}

watch(historyOpen, (open) => {
  if (open) {
    favoritesOpen.value = false;
    // Highlight the last (most recent) item and scroll to it
    nextTick(() => historyDropdownRef.value?.moveHighlight('up'));
  } else {
    nextTick(() => textareaRef.value?.focus());
  }
});

watch(favoritesOpen, (open) => {
  if (open) {
    historyOpen.value = false;
    nextTick(() => favoritesDropdownRef.value?.moveHighlight('down'));
  } else {
    nextTick(() => textareaRef.value?.focus());
  }
});

const sendTooltip = computed(() =>
  enterToSend.value ? t('inputPanel.sendTooltipEnter') : t('inputPanel.sendTooltipCtrlEnter'),
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

const commandPopupDismissed = ref(false);
const agentPopupDismissed = ref(false);

const commandPopupOpen = computed(
  () => !commandPopupDismissed.value && commandMatches.value.length > 0,
);

// --- Agent @ invocation ---
const atQuery = computed(() => {
  const value = messageValue.value;
  const textarea = textareaRef.value;
  // Get cursor position (end of text if textarea not focused or no cursor)
  const cursorPos = textarea?.selectionStart ?? value.length;
  // Get text up to cursor
  const textBeforeCursor = value.slice(0, cursorPos);
  // Find the last @ symbol before cursor
  const lastAtIndex = textBeforeCursor.lastIndexOf('@');
  if (lastAtIndex === -1) return '';
  // Extract text after the @
  const afterAt = textBeforeCursor.slice(lastAtIndex + 1);
  // If @ is followed by whitespace immediately, return empty
  if (afterAt.startsWith(' ') || afterAt.startsWith('\t') || afterAt.startsWith('\n')) return '';
  // Return the word after @ (up to whitespace or end)
  const match = afterAt.match(/^(\S*)/);
  return match?.[1] ?? '';
});

const agentMatches = computed(() => {
  // Check if we're in an @ context (atQuery is not empty OR cursor is right after @)
  const query = atQuery.value;
  const textarea = textareaRef.value;
  const value = messageValue.value;
  const cursorPos = textarea?.selectionStart ?? value.length;
  const textBeforeCursor = value.slice(0, cursorPos);
  const lastAtIndex = textBeforeCursor.lastIndexOf('@');
  
  // We're not in @ context if no @ found
  if (lastAtIndex === -1) return [];
  
  // Check if @ is followed by whitespace (invalid @ context)
  const afterAt = textBeforeCursor.slice(lastAtIndex + 1);
  if (afterAt.startsWith(' ') || afterAt.startsWith('\t') || afterAt.startsWith('\n')) return [];
  
  // Check if there's a space after the agent name (agent already selected)
  const textAfterCursor = value.slice(cursorPos);
  if (textAfterCursor.startsWith(' ')) return [];
  
  const primaryAgents = props.agentOptions ?? [];
  const subagents = props.subagentOptions ?? [];
  const allAgents = [...primaryAgents, ...subagents];
  const matches = allAgents.filter(
    (agent) =>
      agent.label.toLowerCase().startsWith(query.toLowerCase()) ||
      agent.id.toLowerCase().startsWith(query.toLowerCase()),
  );
  return matches;
});

const agentPopupOpen = computed(
  () => !agentPopupDismissed.value && agentMatches.value.length > 0,
);

watch(
  () => messageValue.value,
  () => {
    commandPopupDismissed.value = false;
    agentPopupDismissed.value = false;
  },
);

function handleCommandSelect(name: unknown) {
  if (typeof name === 'string') applyCommandSelection(name);
}

function applyCommandSelection(name: string) {
  messageValue.value = `/${name} `;
  nextTick(() => textareaRef.value?.focus());
}

function handleAgentSelect(id: unknown) {
  if (typeof id === 'string') applyAgentSelection(id);
}

function applyAgentSelection(id: string) {
  const agent = findAgent(id);
  if (!agent) return;
  
  const textarea = textareaRef.value;
  const value = messageValue.value;
  const cursorPos = textarea?.selectionStart ?? value.length;
  
  // Find the last @ before cursor
  const textBeforeCursor = value.slice(0, cursorPos);
  const lastAtIndex = textBeforeCursor.lastIndexOf('@');
  if (lastAtIndex === -1) return;
  
  // Find where the @query ends (next whitespace or cursor position)
  const textAfterAt = value.slice(lastAtIndex + 1);
  const whitespaceMatch = textAfterAt.match(/\s/);
  const queryEndOffset = whitespaceMatch ? whitespaceMatch.index! : textAfterAt.length;
  const queryEndPos = lastAtIndex + 1 + queryEndOffset;
  
  // Build new value: text before @ + @agentName + space + text after query
  const beforeAt = value.slice(0, lastAtIndex);
  const afterQuery = value.slice(queryEndPos);
  const newValue = beforeAt + '@' + agent.label + ' ' + afterQuery;
  
  messageValue.value = newValue;
  
  // Dismiss popup - use double nextTick to ensure it happens after watch resets it
  nextTick(() => {
    nextTick(() => {
      agentPopupDismissed.value = true;
    });
  });
  
  // Set cursor position after the inserted agent name + space
  nextTick(() => {
    const newCursorPos = lastAtIndex + agent.label.length + 2; // +2 for '@' and ' '
    textarea?.setSelectionRange(newCursorPos, newCursorPos);
    textarea?.focus();
  });
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
  if (open) {
    modelSearchQuery.value = '';
  } else {
    nextTick(() => {
      textareaRef.value?.focus();
    });
  }
}

function handleKeydown(event: KeyboardEvent) {
  // --- Agent @ popup: handle first (higher priority than command popup) ---
  if (agentPopupOpen.value) {
    if (event.key === 'Escape') {
      event.preventDefault();
      agentPopupDismissed.value = true;
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      agentDropdownRef.value?.moveHighlight('down');
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      agentDropdownRef.value?.moveHighlight('up');
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
      agentDropdownRef.value?.selectHighlighted();
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
      agentDropdownRef.value?.selectHighlighted();
    }
    return;
  }
  // --- Command / popup ---
  if (commandPopupOpen.value) {
    if (event.key === 'Escape') {
      event.preventDefault();
      commandPopupDismissed.value = true;
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      commandDropdownRef.value?.moveHighlight('down');
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      commandDropdownRef.value?.moveHighlight('up');
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
      commandDropdownRef.value?.selectHighlighted();
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
      commandDropdownRef.value?.selectHighlighted();
    }
    return;
  }
  // --- Input history: open dropdown when ArrowUp on empty input ---
  if (
    event.key === 'ArrowUp' &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    messageValue.value === '' &&
    userHistory.value.length > 0
  ) {
    event.preventDefault();
    historyOpen.value = true;
    return;
  }
  if (
    event.key === 'ArrowDown' &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    messageValue.value === '' &&
    favorites.value.length > 0
  ) {
    event.preventDefault();
    favoritesOpen.value = true;
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

function findAgent(id: unknown): AgentOption | undefined {
  if (id == null) return undefined;
  // Search in both primary agents and subagents
  return (props.agentOptions ?? []).find((a) => a.id === id) ??
         (props.subagentOptions ?? []).find((a) => a.id === id);
}

function resolveAgentStyle(name?: string, explicitColor?: string) {
  const color = explicitColor || props.resolveAgentColor?.(name);
  return color ? { color } : undefined;
}

function agentValueStyle(id: unknown) {
  const agent = findAgent(id);
  return resolveAgentStyle(agent?.id, agent?.color);
}

function agentOptionNameStyle(agent: AgentOption) {
  return resolveAgentStyle(agent.id, agent.color);
}

function findModelOption(id: unknown): ModelOption | undefined {
  if (id == null) return undefined;
  return (props.modelOptions ?? []).find((m) => m.id === id);
}

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

function findThinkingChoice(key: unknown): ThinkingChoice | undefined {
  if (key == null) return undefined;
  return thinkingChoices.value.find((c) => c.key === key);
}

function thinkingValueStyle(key: unknown) {
  const choice = findThinkingChoice(key);
  if (!choice || choice.value === undefined) return undefined;
  return { color: '#f59e0b' };
}

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

function matchesQuery(query: string, ...fields: (string | undefined)[]) {
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return false;
  return terms.every((term) => fields.some((field) => field?.toLowerCase().includes(term)));
}

const filteredGroupedModelOptions = computed(() => {
  const query = modelSearchQuery.value.trim().toLowerCase();
  if (!query) return groupedModelOptions.value;
  return groupedModelOptions.value
    .map((group) => {
      const models = group.models.filter((model) =>
        matchesQuery(query, model.displayName, model.modelID, model.providerID, group.label),
      );
      if (models.length === 0) return null;
      return { ...group, models };
    })
    .filter((group): group is NonNullable<typeof group> => group !== null);
});

function focus() {
  textareaRef.value?.focus();
}

function reset() {
  historyOpen.value = false;
  favoritesOpen.value = false;
  modelSearchQuery.value = '';
}

defineExpose({ focus, reset });

const inputMessageStyle = computed(() => {
  if (!props.agentColor) return undefined;
  const color = props.agentColor;
  // Tint the background with agent color at low opacity
  if (color.startsWith('#') && color.length === 7) {
    return { '--agent-tint': `${color}18` }; // ~0.09 alpha overlay
  }
  return undefined;
});
</script>

<style scoped>
.input-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  color: #e2e8f0;
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
  background-color: rgba(15, 23, 42, 0.92);
  background-image: linear-gradient(var(--agent-tint, transparent), var(--agent-tint, transparent));
  border: 1px solid #334155;
  border-radius: 12px;
  box-sizing: border-box;
  box-shadow: 0 12px 32px rgba(2, 6, 23, 0.45);
}

.input-message:has(.input-textarea:disabled) {
  opacity: 0.6;
}

.input-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 4px 8px 8px;
  border-top: 1px solid rgba(51, 65, 85, 0.35);
  flex: 0 0 auto;
}

.input-selects {
  display: flex;
  flex: 0 1 auto;
  min-width: 0;
  gap: 4px;
  flex-wrap: wrap;
  align-items: center;
}

.input-selects .input-control {
  height: 28px;
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
  flex: 0 0 auto;
  min-width: 0;
}

:deep(.input-control) {
  width: 100%;
  background: transparent;
  color: #94a3b8;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 11px;
  font-family: inherit;
  outline: none;
  box-sizing: border-box;
  transition:
    background 0.15s,
    border-color 0.15s,
    color 0.15s;
}

:deep(.input-control):hover:not(:disabled) {
  background: rgba(51, 65, 85, 0.35);
  color: #e2e8f0;
}

:deep(.input-control):focus-visible {
  outline: none;
}

:deep(.input-dropdown-button) {
  height: 28px;
}

:deep(.input-dropdown-popup) {
  /* Always open upward since input toolbar is at the bottom */
  top: auto;
  bottom: anchor(top);
  margin-top: 0;
  margin-bottom: 6px;
  position-try-fallbacks: none;
  max-height: 280px;
  outline: none;
}

:deep(.input-dropdown-popup:has(.agent-dropdown-item)) {
  min-width: 320px;
}

:deep(.input-dropdown-popup:has(.model-picker)) {
  overflow: hidden;
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-button-label {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  line-height: 1.15;
  text-align: left;
  align-self: flex-start;
}

.model-button-provider {
  position: fixed;
  font-size: 9px;
  color: #94a3b8;
  white-space: nowrap;
  text-overflow: ellipsis;
  transform: translate(-3px, -11px);
}

.model-button-name {
  font-size: 12px;
  color: #e2e8f0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-picker {
  display: flex;
  flex-direction: column;
  max-height: calc(280px - 12px);
  overflow: hidden;
  margin: -6px;
  padding: 6px;
}

.model-picker-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.model-search {
  flex: 0 0 auto;
  padding: 0 0 4px;
}

.model-search :deep(.ui-dropdown-search-input) {
  border-radius: 6px;
  font-size: 11px;
  font-family: inherit;
  padding: 4px 6px;
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
  font-size: 14px;
  line-height: 1.5;
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
  padding: 12px 16px;
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

.command-dropdown-wrapper {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 0;
  overflow: visible;
  pointer-events: none;
}
.command-dropdown-wrapper :deep(.ui-dropdown-menu) {
  pointer-events: auto;
}

:deep(.command-popup) {
  /* Open upward instead of downward */
  top: auto;
  bottom: anchor(top);
  margin-top: 0;
  margin-bottom: 8px;
  max-height: 220px;
}

:deep(.command-popup) .ui-dropdown-item[aria-selected='true'] {
  background: rgba(59, 130, 246, 0.2);
  border: 1px solid rgba(59, 130, 246, 0.45);
}

.command-dropdown-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  min-width: 0;
}
.command-name {
  font-size: 12px;
  color: #e2e8f0;
  line-height: 1.2;
}
.command-desc {
  font-size: 10px;
  color: #94a3b8;
  line-height: 1.2;
}

.agent-dropdown-wrapper {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 0;
  overflow: visible;
  pointer-events: none;
}
.agent-dropdown-wrapper :deep(.ui-dropdown-menu) {
  pointer-events: auto;
}

:deep(.agent-popup) {
  /* Open upward instead of downward */
  top: auto;
  bottom: anchor(top);
  margin-top: 0;
  margin-bottom: 8px;
  max-height: 220px;
}

:deep(.agent-popup) .ui-dropdown-item[aria-selected='true'] {
  background: rgba(59, 130, 246, 0.2);
  border: 1px solid rgba(59, 130, 246, 0.45);
}

.agent-popup-name {
  font-size: 12px;
  color: #e2e8f0;
  line-height: 1.2;
}
.agent-mode-badge {
  font-size: 10px;
  color: #94a3b8;
  margin-left: 6px;
  font-weight: 500;
}
.agent-popup-description {
  font-size: 10px;
  color: #94a3b8;
  line-height: 1.2;
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
  flex: 1 1 auto;
  min-width: 0;
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

.history-item-target {
  font-size: 10px;
  font-weight: 600;
  margin-top: 4px;
  opacity: 0.92;
  display: flex;
  align-items: baseline;
  gap: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.history-target-agent,
.history-target-model,
.history-target-provider,
.history-target-separator,
.history-target-variant {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.history-target-model {
  color: #f8fafc;
}

.history-target-provider {
  color: #94a3b8;
}

.history-target-separator {
  color: #94a3b8;
}

.history-target-variant {
  color: #f59e0b;
}

.history-action-button {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: #64748b;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.history-action-button:hover {
  color: #4ade80;
  background: rgba(34, 197, 94, 0.14);
  border-color: rgba(34, 197, 94, 0.3);
}

.history-action-button.is-favorited {
  color: #4ade80;
}

.history-action-button.remove:hover {
  color: #f87171;
  background: rgba(248, 113, 113, 0.14);
  border-color: rgba(248, 113, 113, 0.3);
}

.input-button {
  background: transparent;
  color: #94a3b8;
  border: 1px solid transparent;
  border-radius: 8px;
  width: 28px;
  height: 28px;
  padding: 0;
  font-size: 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition:
    background 0.15s,
    color 0.15s;
}

.input-button:hover:not(:disabled) {
  background: rgba(51, 65, 85, 0.35);
  color: #e2e8f0;
}

.input-button:disabled {
  opacity: 0.6;
  cursor: default;
}

.input-button.primary {
  background: rgba(37, 99, 235, 0.2);
  border-color: transparent;
  border-radius: 50%;
  width: 32px;
  height: 32px;
  color: #60a5fa;
}

.input-button.primary:hover:not(:disabled) {
  background: rgba(37, 99, 235, 0.35);
  color: #93bbfd;
}

.input-button.stop {
  background: rgba(220, 38, 38, 0.2);
  border-color: transparent;
  border-radius: 50%;
  width: 32px;
  height: 32px;
  color: #f87171;
}

.input-button.stop:hover:not(:disabled) {
  background: rgba(220, 38, 38, 0.35);
  color: #fca5a5;
}

.input-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  flex: 0 0 auto;
}

.suppress-button {
}

.suppress-button.active {
  background: rgba(239, 68, 68, 0.2);
  color: #f87171;
}

.suppress-button.active:hover {
  background: rgba(239, 68, 68, 0.35);
  color: #fca5a5;
}

.bookmark-button {
  position: relative;
}

.bookmark-button:hover:not(:disabled) {
  background: rgba(34, 197, 94, 0.15);
  color: #4ade80;
}

.bookmark-toast {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: rgba(15, 23, 42, 0.95);
  color: #4ade80;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid rgba(34, 197, 94, 0.35);
  box-shadow: 0 4px 12px rgba(2, 6, 23, 0.5);
  pointer-events: none;
}

.bookmark-toast-enter-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.bookmark-toast-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}

.bookmark-toast-enter-from {
  opacity: 0;
  transform: translateX(-50%) translateY(4px);
}

.bookmark-toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-4px);
}
</style>
