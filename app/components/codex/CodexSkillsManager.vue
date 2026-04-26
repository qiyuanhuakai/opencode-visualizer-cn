<template>
  <section class="codex-skills-manager" :aria-label="t('codexPanel.skillsTitle')">
    <div class="codex-section-title">
      <span>{{ t('codexPanel.skillsTitle') }}</span>
      <div class="codex-skills-tools">
        <button
          type="button"
          class="codex-small-button"
          :disabled="!api.connected.value || api.skillsLoading.value"
          :title="t('codexPanel.skillsRefresh')"
          @click="api.refreshSkills()"
        >
          <Icon icon="mdi:refresh" width="16" :class="{ 'codex-spin': api.skillsLoading.value }" />
        </button>
      </div>
    </div>

    <div v-if="api.skillsLoading.value" class="codex-empty">
      {{ t('common.loading') }}
    </div>
    <div v-else-if="api.skills.value.length === 0" class="codex-empty">
      {{ api.connected.value ? t('codexPanel.skillsNoSkills') : t('codexPanel.connectToLoad') }}
    </div>
    <div v-else class="codex-skills-list">
      <div
        v-for="skill in api.skills.value"
        :key="skill.name"
        class="codex-skill-item"
        :class="{ 'is-enabled': skill.enabled }"
      >
        <div class="codex-skill-header">
          <div class="codex-skill-info">
            <span class="codex-skill-name">{{ skill.name }}</span>
            <span v-if="skill.interface?.displayName" class="codex-skill-display-name">
              {{ skill.interface.displayName }}
            </span>
          </div>
          <label class="codex-skill-toggle">
            <input
              type="checkbox"
              :checked="skill.enabled"
              :disabled="!api.connected.value"
              @change="api.toggleSkill(skill.name, ($event.target as HTMLInputElement).checked)"
            />
            <span class="codex-skill-toggle-slider" />
          </label>
        </div>
        <p class="codex-skill-description">
          {{ skill.interface?.shortDescription || skill.description || t('common.empty') }}
        </p>
        <div v-if="skill.dependencies?.tools?.length" class="codex-skill-dependencies">
          <span class="codex-skill-dependencies-label">{{ t('codexPanel.skillsDependencies') }}</span>
          <div class="codex-skill-dependencies-list">
            <span
              v-for="(dep, idx) in skill.dependencies.tools"
              :key="idx"
              class="codex-skill-dependency-tag"
              :class="`is-type-${dep.type}`"
            >
              {{ dep.type }}: {{ dep.value }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import type { useCodexApi } from '../../composables/useCodexApi';

const { t } = useI18n();

defineProps<{
  api: ReturnType<typeof useCodexApi>;
}>();
</script>

<style scoped>
.codex-skills-manager {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  min-height: 0;
}

.codex-skills-tools {
  display: flex;
  gap: 6px;
}

.codex-skills-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
}

.codex-skill-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.35);
  transition: border-color 0.2s ease;
}

.codex-skill-item.is-enabled {
  border-color: rgba(74, 222, 128, 0.3);
}

.codex-skill-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.codex-skill-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.codex-skill-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--theme-text-primary, #e2e8f0);
  word-break: break-word;
}

.codex-skill-display-name {
  font-size: 11px;
  color: var(--theme-text-muted, #94a3b8);
}

.codex-skill-description {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--theme-text-secondary, #cbd5e1);
  word-break: break-word;
}

.codex-skill-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 40px;
  height: 22px;
  flex-shrink: 0;
  cursor: pointer;
}

.codex-skill-toggle input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.codex-skill-toggle-slider {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--theme-border, rgba(148, 163, 184, 0.35));
  transition: background 0.2s ease;
}

.codex-skill-toggle-slider::before {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--theme-text-primary, #e2e8f0);
  transition: transform 0.2s ease;
}

.codex-skill-toggle input:checked + .codex-skill-toggle-slider {
  background: rgba(74, 222, 128, 0.45);
}

.codex-skill-toggle input:checked + .codex-skill-toggle-slider::before {
  transform: translateX(18px);
  background: #4ade80;
}

.codex-skill-toggle input:disabled + .codex-skill-toggle-slider {
  opacity: 0.5;
  cursor: not-allowed;
}

.codex-skill-dependencies {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.codex-skill-dependencies-label {
  font-size: 10px;
  color: var(--theme-text-muted, #94a3b8);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.codex-skill-dependencies-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.codex-skill-dependency-tag {
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  background: rgba(148, 163, 184, 0.15);
  color: var(--theme-text-muted, #94a3b8);
}

.codex-skill-dependency-tag.is-type-env_var {
  background: rgba(96, 165, 250, 0.15);
  color: var(--theme-accent-primary, #93c5fd);
}

.codex-skill-dependency-tag.is-type-mcp {
  background: rgba(167, 139, 250, 0.15);
  color: #c4b5fd;
}

.codex-empty {
  color: var(--theme-text-muted, #94a3b8);
  font-size: 12px;
}

.codex-spin {
  animation: codex-spin-anim 1s linear infinite;
}

@keyframes codex-spin-anim {
  to {
    transform: rotate(360deg);
  }
}
</style>
