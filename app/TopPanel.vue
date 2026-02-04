<template>
  <div class="top-panel">
    <div class="top-row">
      <div class="top-field">
        <select
          id="project-select"
          v-model="projectValue"
          class="control-input top-select"
          aria-label="Project"
          title="Project"
        >
          <option v-if="projects.length === 0" disabled value="">No projects</option>
          <option v-for="project in projects" :key="project.id" :value="project.id">
            {{ projectLabel(project) }}
          </option>
        </select>
        <button type="button" class="control-button" @click="$emit('new-project')">
          New
        </button>
      </div>
      <div class="top-field">
        <select
          id="session-select"
          v-model="sessionValue"
          class="control-input top-select"
          aria-label="Session"
          title="Session"
        >
          <option v-if="sessions.length === 0" disabled value="">No sessions</option>
          <option v-for="session in sessions" :key="session.id" :value="session.id">
            {{ sessionLabel(session) }}
          </option>
        </select>
        <button type="button" class="control-button" @click="$emit('new-session')">
          New
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
type ProjectInfo = {
  id: string;
  worktree?: string;
};

type SessionInfo = {
  id: string;
  projectID?: string;
  parentID?: string;
  title?: string;
  slug?: string;
  directory?: string;
};

const props = defineProps<{
  projects: ProjectInfo[];
  sessions: SessionInfo[];
  selectedProjectId: string;
  selectedSessionId: string;
}>();

const emit = defineEmits<{
  (event: 'update:selected-project-id', value: string): void;
  (event: 'update:selected-session-id', value: string): void;
  (event: 'new-project'): void;
  (event: 'new-session'): void;
}>();

const projectValue = computed({
  get: () => props.selectedProjectId,
  set: (value) => emit('update:selected-project-id', value),
});

const sessionValue = computed({
  get: () => props.selectedSessionId,
  set: (value) => emit('update:selected-session-id', value),
});

function projectLabel(project: ProjectInfo) {
  if (project.id === 'global') return 'global /';
  if (project.worktree) return project.worktree;
  return project.id;
}

function sessionLabel(session: SessionInfo) {
  const base = session.title || session.slug || session.id;
  return `${base} (${session.id.slice(0, 6)})`;
}
</script>

<style scoped>
.top-panel {
  position: relative;
  background: rgba(15, 23, 42, 0.92);
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 12px;
  padding: 10px;
  box-shadow: 0 12px 32px rgba(2, 6, 23, 0.45);
  z-index: 20;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
}

.top-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
  flex-wrap: wrap;
}

.top-field {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 320px;
  min-width: 0;
}

.control-input {
  flex: 1 1 auto;
  min-width: 0;
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

.top-select {
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
}

.control-button {
  background: #1e293b;
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}
</style>
