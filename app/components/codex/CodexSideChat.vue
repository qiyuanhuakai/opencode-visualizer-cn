<template>
  <section class="command-panel" :aria-label="t('sideTitle')">
    <p class="command-hint">{{ t('sideHint') }}</p>
    <p v-if="!api.connected.value" role="status" class="command-hint">{{ t('disconnected') }}</p>
    <div ref="transcript" class="command-transcript" role="log" :aria-label="t('sideTitle')" aria-live="polite" tabindex="0">
      <p v-if="!api.sideChat.value?.messages.length" class="command-hint">{{ t('emptyChat') }}</p>
      <article v-for="message in api.sideChat.value?.messages" :key="message.id" class="command-message">
        <span class="command-role">{{ t(message.role) }}</span>
        <p class="command-message-text">{{ message.text }}</p>
      </article>
      <p v-if="api.sideChat.value?.pending" role="status" class="command-hint">{{ t('pending') }}</p>
    </div>
    <p v-if="error || api.sideChat.value?.error" role="alert" class="command-error">{{ error || api.sideChat.value?.error }}</p>
    <form class="command-form" @submit.prevent="send">
      <label class="command-label">
        {{ t('prompt') }}
        <textarea ref="input" v-model="prompt" class="command-input" rows="3" :disabled="!api.connected.value || closing" @keydown="onKeydown" />
      </label>
      <div class="command-actions">
        <button type="button" class="command-button" :disabled="closing" @click="close">{{ t('close') }}</button>
        <button type="submit" class="command-button command-primary" :disabled="!canSend">{{ t('send') }}</button>
      </div>
    </form>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { useCodexApi } from '../../composables/useCodexApi';
import { codexCommandUi } from '../../locales/codexCommandUi';
const props = defineProps<{
  api: Pick<ReturnType<typeof useCodexApi>, 'connected' | 'sideChat' | 'startSideChat' | 'sendSidePrompt' | 'closeSideChat'>;
}>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n({ useScope: 'local', messages: codexCommandUi });
const prompt = ref('');
const error = ref('');
const sending = ref(false);
const closing = ref(false);
const input = ref<HTMLTextAreaElement | null>(null);
const transcript = ref<HTMLDivElement | null>(null);
const canSend = computed(() => props.api.connected.value && !!prompt.value.trim() && !sending.value && !closing.value && !props.api.sideChat.value?.pending);
onMounted(() => input.value?.focus());
watch(() => props.api.sideChat.value?.messages.map(message => message.text).join(''), async () => {
  const element = transcript.value;
  if (!element || element.scrollHeight - element.scrollTop - element.clientHeight > 48) return;
  await nextTick();
  element.scrollTop = element.scrollHeight;
});
async function send() {
  if (!canSend.value) return;
  const text = prompt.value.trim();
  error.value = '';
  sending.value = true;
  try {
    if (props.api.sideChat.value) await props.api.sendSidePrompt(text);
    else await props.api.startSideChat(text);
    if (prompt.value.trim() === text) prompt.value = '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    sending.value = false;
  }
}
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  void send();
}
async function close() {
  if (closing.value) return;
  closing.value = true;
  error.value = '';
  try {
    await props.api.closeSideChat();
    emit('close');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    closing.value = false;
  }
}
</script>

<style scoped src="./codexCommandPanels.css"></style>
