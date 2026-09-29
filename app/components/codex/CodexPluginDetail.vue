<template>
  <div class="rounded-lg border border-[var(--theme-border-subtle)] [background:var(--theme-card-bg)] p-2 text-xs text-[var(--theme-text-muted)]">
    <div v-if="result.plugin.skills.length" class="mb-2">
      <span class="font-semibold text-[var(--theme-text-secondary)]">{{ t('codexPanel.pluginBundledSkills') }}</span>
      <code v-for="skill in result.plugin.skills" :key="skill.path || skill.name" class="mt-1 block">{{ skill.name }}</code>
    </div>
    <div v-if="result.plugin.apps.length" class="mb-2">
      <span class="font-semibold text-[var(--theme-text-secondary)]">{{ t('codexPanel.pluginBundledApps') }}</span>
      <code v-for="app in result.plugin.apps" :key="app.id || app.name" class="mt-1 block">{{ app.name }}</code>
    </div>
    <div v-if="result.plugin.mcpServers.length">
      <span class="font-semibold text-[var(--theme-text-secondary)]">{{ t('codexPanel.pluginBundledMcp') }}</span>
      <code v-for="server in result.plugin.mcpServers" :key="server" class="mt-1 block">{{ server }}</code>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { CodexPluginReadResult } from '../../backends/codex/codexAdapter';

defineProps<{ result: CodexPluginReadResult }>();
const { t } = useI18n();
</script>
