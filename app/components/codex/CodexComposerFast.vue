<template>
  <button type="button" class="codex-composer-fast" :class="{ 'is-active': enabled }" :aria-pressed="enabled" :aria-busy="saving" :disabled="saving || !api.connected.value" :title="title" @click="toggle">
    <Icon icon="lucide:zap" :width="14" :height="14" aria-hidden="true" />
    <span>Fast</span>
    <span class="fast-state">{{ state }}</span>
  </button>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import type { useCodexApi } from '../../composables/useCodexApi';

const props = defineProps<{ api: Pick<ReturnType<typeof useCodexApi>, 'selectedServiceTier' | 'models' | 'connected' | 'setFastMode'> }>();
const emit = defineEmits<{ error: [message: string] }>();
const saving = ref(false);
const { locale } = useI18n();
const copy = computed(() => {
  switch (locale.value) {
    case 'zh-CN': return { on: '开启', off: '关闭', disconnected: '未连接', hint: '点击或输入 /fast 切换；下一条消息生效' };
    case 'zh-TW': return { on: '開啟', off: '關閉', disconnected: '未連接', hint: '點擊或輸入 /fast 切換；下一則訊息生效' };
    case 'ja': return { on: 'オン', off: 'オフ', disconnected: '未接続', hint: 'クリックまたは /fast で切り替え。次のメッセージから適用' };
    case 'eo': return { on: 'Ŝaltita', off: 'Malŝaltita', disconnected: 'Malkonektita', hint: 'Alklaku aŭ uzu /fast por ŝanĝi la sekvan mesaĝon' };
    default: return { on: 'On', off: 'Off', disconnected: 'Disconnected', hint: 'Click or use /fast to toggle; applies to the next message' };
  }
});
const enabled = computed(() => props.api.connected.value && props.api.models.value.some(model =>
  model.serviceTiers?.some(tier => tier.id === props.api.selectedServiceTier.value
    && (/^(fast|priority)$/i.test(tier.id) || /^fast$/i.test(tier.name)))));
const state = computed(() => !props.api.connected.value ? copy.value.disconnected : enabled.value ? copy.value.on : copy.value.off);
const title = computed(() => `Fast: ${state.value}. ${copy.value.hint}`);
async function toggle() {
  if (saving.value || !props.api.connected.value) return;
  saving.value = true;
  try {
    await props.api.setFastMode(!enabled.value);
  } catch (error) {
    emit('error', error instanceof Error ? error.message : String(error));
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.codex-composer-fast {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  color: var(--theme-input-text-muted, var(--theme-text-muted));
  font-family: inherit;
  font-size: 12px;
  white-space: nowrap;
}
.codex-composer-fast.is-active { color: var(--theme-input-accent, var(--theme-border-accent)); }
.codex-composer-fast:hover:not(:disabled) { background: var(--theme-surface-panel-hover); }
.codex-composer-fast:focus-visible { outline: 2px solid var(--theme-input-accent, var(--theme-border-accent)); outline-offset: 2px; }
.codex-composer-fast:disabled { opacity: 0.5; cursor: not-allowed; }
.fast-state { font-size: 10px; }
</style>
