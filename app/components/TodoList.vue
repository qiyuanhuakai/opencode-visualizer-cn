<template>
  <div class="todo-body">
    <div class="todo-header">
      <div class="todo-title">{{ t('sidePanel.todo.title') }}</div>
      <div class="todo-count">{{ totalCount }}</div>
    </div>
      <div v-if="sessions.length === 0" class="todo-empty">{{ t('sidePanel.todo.empty') }}</div>
    <div v-else class="todo-groups">
      <section v-for="session in sessions" :key="session.sessionId" class="todo-group">
        <header class="todo-group-header">
          <span class="todo-group-title">{{ session.title }}</span>
          <span v-if="session.isSubagent" class="todo-badge">{{ t('common.subagent') }}</span>
        </header>
        <div v-if="session.error" class="todo-error">{{ session.error }}</div>
        <ul v-else class="todo-list">
          <li
            v-for="(todo, index) in session.todos"
            :key="index"
            class="todo-item"
            :class="`is-${todo.status}`"
          >
            <span class="todo-status" :title="statusLabel(todo.status)">{{ statusIcon(todo.status) }}</span>
            <span class="todo-text">{{ todo.content }}</span>
            <span class="todo-priority" :class="`is-${todo.priority}`">{{ priorityLabel(todo.priority) }}</span>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

type TodoEntry = {
  content: string;
  status: string;
  priority: string;
};

type TodoSession = {
  sessionId: string;
  title: string;
  isSubagent: boolean;
  todos: TodoEntry[];
  loading: boolean;
  error: string | undefined;
};

const props = defineProps<{
  sessions: TodoSession[];
}>();

const totalCount = computed(() =>
  props.sessions.reduce((sum, session) => sum + session.todos.length, 0),
);

function statusIcon(status: string) {
  if (status === 'completed') return '✓';
  if (status === 'in_progress') return '◐';
  if (status === 'cancelled') return '✕';
  return '○';
}

function statusLabel(status: string): string {
  const key = status === 'in_progress' ? 'inProgress' : status;
  return t(`todoStatus.${key}`, status);
}

function priorityLabel(priority: string): string {
  return t(`todoPriority.${priority}`, priority);
}
</script>

<style scoped>
.todo-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.todo-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 10px 8px;
  border-bottom: 1px solid rgba(100, 116, 139, 0.28);
}

.todo-title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #e2e8f0;
}

.todo-count {
  font-size: 11px;
  color: var(--region-side-text-muted, #94a3b8);
}

.todo-empty {
  margin: auto;
  color: rgba(148, 163, 184, 0.9);
  font-size: 12px;
}

.todo-groups {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.todo-group {
  border: 1px solid rgba(71, 85, 105, 0.55);
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.6);
}

.todo-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px;
  border-bottom: 1px solid rgba(71, 85, 105, 0.42);
}

.todo-group-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  color: #e2e8f0;
}

.todo-badge {
  margin-left: auto;
  padding: 1px 5px;
  border-radius: 999px;
  border: 1px solid rgba(59, 130, 246, 0.5);
  color: #93c5fd;
  background: rgba(30, 64, 175, 0.25);
  font-size: 10px;
}

.todo-error {
  padding: 8px;
  color: #fca5a5;
  font-size: 11px;
}

.todo-list {
  list-style: none;
  margin: 0;
  padding: 6px 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.todo-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  color: #dbeafe;
}

.todo-status {
  width: 14px;
  text-align: center;
  color: #e2e8f0;
}

.todo-item.is-completed .todo-status {
  color: #86efac;
}

.todo-item.is-in_progress .todo-status {
  color: #fcd34d;
}

.todo-item.is-cancelled .todo-status {
  color: #fca5a5;
}

.todo-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.todo-priority {
  flex: 0 0 auto;
  text-transform: uppercase;
  font-size: 9px;
  letter-spacing: 0.07em;
  color: #cbd5e1;
  border: 1px solid rgba(148, 163, 184, 0.45);
  border-radius: 999px;
  padding: 2px 5px;
}

.todo-priority.is-high {
  color: #fecaca;
  border-color: rgba(248, 113, 113, 0.6);
}

.todo-priority.is-medium {
  color: #fde68a;
  border-color: rgba(250, 204, 21, 0.6);
}

.todo-priority.is-low {
  color: #86efac;
  border-color: rgba(74, 222, 128, 0.6);
}
</style>
