<template>
  <section class="btw-window">
    <div ref="historyElement" class="btw-history" role="log" aria-live="polite">
      <p v-if="loading && !turns.length" class="hint">{{ t('loading') }}</p>
      <p v-else-if="!turns.length" class="hint">{{ t('empty') }}</p>
      <article v-for="(turn, index) in turns" :key="turn.turnId" class="btw-turn">
        <div v-if="turn.prompt" class="btw-message btw-user"><span class="btw-role">{{ t('you') }}</span><p>{{ turn.prompt }}</p></div>
        <template v-for="step in turn.steps" :key="step.stepId">
          <template v-for="frame in step.frames" :key="frame.frameId">
            <div v-if="frame.kind === 'text' && frame.role === 'assistant'" class="btw-message btw-assistant"><span class="btw-role">Kimi</span><p>{{ frame.text }}</p></div>
            <details v-else-if="frame.kind === 'tool'" class="btw-tool"><summary>{{ frame.name }} · {{ frame.state }}</summary><pre v-if="frame.input !== undefined">{{ formatValue(frame.input) }}</pre><pre v-if="frame.output !== undefined">{{ formatValue(frame.output) }}</pre><p v-if="frame.error" class="error">{{ frame.error }}</p></details>
            <p v-else-if="frame.kind === 'notice'" class="btw-notice">{{ frame.message }}</p>
          </template>
        </template>
        <p v-if="isTurnThinking(turn, index)" class="hint">{{ t('working') }}</p>
        <p v-if="turn.error" class="error">{{ turn.error }}</p>
      </article>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
    </div>
    <form class="btw-composer" @submit.prevent="send">
      <textarea v-model="draft" :aria-label="t('question')" :placeholder="t('question')" :disabled="sending || !ready" rows="2" @keydown.ctrl.enter.prevent="send" @keydown.meta.enter.prevent="send" />
      <button type="submit" :disabled="sending || !ready || !draft.trim()">{{ t('send') }}</button>
    </form>
  </section>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { KimiWebAgentTranscript, KimiWebClient } from '../../utils/kimiWeb';

const props = defineProps<{ sessionId: string; agentId: string; client: KimiWebClient; initialPrompt?: string }>();
const messages = {
  en: { loading: 'Loading conversation…', empty: 'Ask a side question to start.', you: 'You', working: 'Thinking…', question: 'Ask a follow-up…', send: 'Send' },
  'zh-CN': { loading: '正在加载对话…', empty: '输入旁支问题以开始。', you: '你', working: '思考中…', question: '继续追问…', send: '发送' },
  'zh-TW': { loading: '正在載入對話…', empty: '輸入旁支問題以開始。', you: '你', working: '思考中…', question: '繼續追問…', send: '傳送' },
  ja: { loading: '会話を読み込み中…', empty: '質問を入力してください。', you: 'あなた', working: '思考中…', question: '続けて質問…', send: '送信' },
  eo: { loading: 'Ŝargante konversacion…', empty: 'Faru flankan demandon.', you: 'Vi', working: 'Pensante…', question: 'Plua demando…', send: 'Sendi' },
};
const { t } = useI18n({ useScope: 'local', messages });
type Turn = Extract<KimiWebAgentTranscript['items'][number], { kind: 'turn' }>;
const turns = ref<Turn[]>([]);
const draft = ref('');
const sending = ref(false);
const loading = ref(true);
const ready = ref(false);
const error = ref('');
const historyElement = ref<HTMLElement>();
let disposed = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let refreshing = false;
let baselineOrdinal = -1;
function formatValue(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? ''; }
function isTurnThinking(turn: Turn, index: number): boolean {
  return index === turns.value.length - 1
    && (turn.state === 'running' || turn.state === 'queued')
    && !turn.error
    && !turn.steps.some((step) => step.frames.some((frame) => frame.kind === 'text' && frame.role === 'assistant' && frame.text.trim()));
}
async function refresh() {
  if (disposed || refreshing) return;
  refreshing = true;
  try {
    const pages: Turn[][] = [];
    let before: string | undefined;
    for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
      const page = await props.client.getAgentTranscript(props.sessionId, props.agentId, before);
      pages.unshift(page.items.filter((item): item is Turn => item.kind === 'turn'));
      if (!page.has_more) break;
      const oldest = page.items.find((item): item is Turn => item.kind === 'turn');
      if (!oldest?.turnId || oldest.turnId === before) break;
      before = oldest.turnId;
    }
    if (disposed) return;
    const history = historyElement.value;
    const wasNearBottom = !history || history.scrollHeight - history.scrollTop - history.clientHeight < 80;
    turns.value = pages.flat().filter((turn) => turn.ordinal > baselineOrdinal);
    error.value = '';
    if (wasNearBottom) {
      await nextTick();
      historyElement.value?.scrollTo({ top: historyElement.value.scrollHeight });
    }
  } catch (cause) {
    if (!disposed) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    refreshing = false;
    loading.value = false;
    if (!disposed) timer = setTimeout(() => { void refresh(); }, 1500);
  }
}
async function send() {
  const question = draft.value.trim();
  if (!question || sending.value || !ready.value) return;
  sending.value = true;
  error.value = '';
  try {
    const accepted = await props.client.sendPrompt(props.sessionId, { agent_id: props.agentId, content: [{ type: 'text', text: question }] });
    if (accepted.status === 'blocked') throw new Error('Kimi Web blocked the side question.');
    draft.value = '';
    await refresh();
  } catch (cause) {
    if (!disposed) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally { sending.value = false; }
}
async function initialize() {
  try {
    const baseline = await props.client.getAgentTranscript(props.sessionId, props.agentId);
    if (disposed) return;
    baselineOrdinal = Math.max(-1, ...baseline.items.filter((item): item is Turn => item.kind === 'turn').map((item) => item.ordinal));
    ready.value = true;
    loading.value = false;
    if (props.initialPrompt) {
      draft.value = props.initialPrompt;
      await send();
    } else void refresh();
  } catch (cause) {
    if (!disposed) {
      loading.value = false;
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }
}
onMounted(() => { void initialize(); });
onBeforeUnmount(() => { disposed = true; if (timer) clearTimeout(timer); });
</script>

<style scoped>
.btw-window { height: 100%; display: flex; flex-direction: column; background: var(--theme-floating-surface-base, var(--theme-surface-panel)); color: var(--theme-floating-text, var(--theme-text-primary)); font-size: var(--type-sm); }
.btw-history { flex: 1; min-height: 0; overflow: auto; padding: var(--space-3); }
.btw-turn { display: grid; gap: var(--space-2); margin-bottom: var(--space-3); }
.btw-message { max-width: 95%; padding: var(--space-2) var(--space-3); border: 1px solid var(--theme-floating-border-muted, var(--theme-border-default)); border-radius: var(--radius-control); background: var(--theme-floating-surface-subtle, var(--theme-surface-panel-muted)); overflow-wrap: anywhere; }
.btw-user { justify-self: end; background: var(--theme-input-surface, var(--theme-surface-panel)); }
.btw-role { color: var(--theme-text-muted); font-size: var(--type-caption); }
.btw-message p { margin: var(--space-1) 0 0; white-space: pre-wrap; }
.btw-tool { padding: var(--space-2); border: 1px solid var(--theme-floating-border-muted, var(--theme-border-default)); border-radius: var(--radius-control); }
.btw-tool summary { cursor: pointer; }
.btw-tool pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.btw-composer { display: flex; align-items: flex-end; gap: var(--space-2); padding: var(--space-3); border-top: 1px solid var(--theme-floating-border-muted, var(--theme-border-default)); }
.btw-composer textarea { flex: 1; min-width: 0; resize: vertical; padding: var(--space-2); border: 1px solid var(--theme-input-border); border-radius: var(--radius-control); color: var(--theme-input-text); background: var(--theme-input-surface); font: inherit; }
.btw-composer button { padding: var(--space-2) var(--space-3); border: 1px solid var(--theme-input-border); border-radius: var(--radius-control); color: var(--theme-input-text); background: var(--theme-input-surface); cursor: pointer; }
.btw-composer button:disabled { opacity: .5; cursor: default; }
.hint { color: var(--theme-text-muted); }
.error { color: var(--theme-status-error); }
</style>
