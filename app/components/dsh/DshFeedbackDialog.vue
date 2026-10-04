<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DshRpcClient } from '../../utils/dshRpc';
import { DSH_FEEDBACK_CATEGORIES, recordDshSessionFeedback, type DshFeedbackCategory } from './sessionFeedback';
const props = defineProps<{ rpc: Pick<DshRpcClient, 'call'>; sessionId: string }>();
const emit = defineEmits<{ (event: 'close'): void }>();
const { locale } = useI18n();
const text = ref('');
const category = ref<DshFeedbackCategory | ''>('');
const busy = ref(false);
const saved = ref(false);
const error = ref('');
let generation = 0;
const copy = computed(() => locale.value.startsWith('zh') ? {
  title: '会话反馈', scope: '仅记录在此会话的本地日志中，不会向外部发送。', session: '会话', note: '反馈内容（可选）', category: '分类（可选）', save: '记录反馈', saving: '正在记录…', saved: '反馈已记录到本地会话日志。', close: '关闭',
  categories: { 'task-result': '任务结果', 'instruction-following': '指令理解与遵循', 'product-interaction': '产品功能与交互', 'service-stability': '稳定性和速度', 'resource-cost': '资源使用与费用', 'security-privacy-permission': '安全隐私与权限', other: '其他' },
} : {
  title: 'Session feedback', scope: 'Recorded only in this session’s local log. Nothing is sent externally.', session: 'Session', note: 'Feedback (optional)', category: 'Category (optional)', save: 'Record feedback', saving: 'Recording…', saved: 'Feedback recorded in the local session log.', close: 'Close',
  categories: { 'task-result': 'Task result', 'instruction-following': 'Instruction following', 'product-interaction': 'Product interaction', 'service-stability': 'Stability and speed', 'resource-cost': 'Resource usage and cost', 'security-privacy-permission': 'Security, privacy and permissions', other: 'Other' },
});
onBeforeUnmount(() => { generation++; });
watch(() => [props.rpc, props.sessionId], () => { generation++; text.value = ''; category.value = ''; error.value = ''; saved.value = false; busy.value = false; });
async function save() {
  if (busy.value || saved.value || !props.sessionId.trim()) return;
  const current = ++generation;
  busy.value = true;
  error.value = '';
  try {
    await recordDshSessionFeedback(props.rpc, { sessionId: props.sessionId, text: text.value, category: category.value });
    if (current === generation) saved.value = true;
  } catch (reason) {
    if (current === generation) error.value = reason instanceof Error ? reason.message : String(reason);
  } finally { if (current === generation) busy.value = false; }
}
</script>
<template>
  <section class="dsh-feedback-dialog" :aria-label="copy.title">
    <form :aria-busy="busy" @submit.prevent="save">
      <p>{{ copy.scope }}</p><small>{{ copy.session }}: {{ sessionId }}</small>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="saved" role="status">{{ copy.saved }}</p>
      <fieldset :disabled="busy || saved">
        <legend>{{ copy.category }}</legend>
        <div class="feedback-categories"><button v-for="item in DSH_FEEDBACK_CATEGORIES" :key="item" type="button" :aria-pressed="category === item" :data-feedback-category="item" @click="category = category === item ? '' : item">{{ copy.categories[item] }}</button></div>
        <label>{{ copy.note }}<textarea v-model="text" rows="5" /></label>
      </fieldset>
      <footer><button type="button" @click="emit('close')">{{ copy.close }}</button><button v-if="!saved" type="submit" :disabled="busy || !sessionId.trim()">{{ busy ? copy.saving : copy.save }}</button></footer>
    </form>
  </section>
</template>
<style scoped>
.dsh-feedback-dialog { height: 100%; overflow: auto; box-sizing: border-box; background: var(--theme-floating-surface-base, var(--theme-surface-panel)); color: var(--theme-floating-text, var(--theme-text-primary)); font: inherit; font-size: var(--type-body); }
header, footer { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); }
header { padding: var(--space-3); border-bottom: 1px solid var(--theme-modal-border); }
form { display: grid; gap: var(--space-3); padding: var(--space-3); }
fieldset, label { display: grid; gap: var(--space-2); min-width: 0; }
fieldset { padding: 0; margin: 0; border: 0; }
legend { padding: 0; margin-bottom: var(--space-2); }
.feedback-categories { display: flex; flex-wrap: wrap; gap: var(--space-2); }
button, textarea { padding: var(--space-2); border: 1px solid var(--theme-floating-border-subtle, var(--theme-border-default)); border-radius: var(--radius-control); background: var(--theme-floating-surface-subtle, var(--theme-surface-panel-muted)); color: inherit; font: inherit; }
button { cursor: pointer; }
button[aria-pressed='true'] { background: var(--theme-surface-panel-hover); color: var(--theme-text-accent); }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible, textarea:focus-visible { outline: 2px solid var(--theme-border-accent); outline-offset: 2px; }
textarea { min-width: 0; resize: vertical; }
p { margin: 0; }
p, small { overflow-wrap: anywhere; }
small { color: var(--theme-floating-text-muted, var(--theme-text-muted)); }
[role='alert'] { color: var(--theme-text-danger); }
footer { justify-content: flex-end; }
</style>
