<template>
  <section class="evidence-view" data-runtime-ui data-testid="context-evidence-view" :aria-label="rt('Context checkpoint and evidence')">
    <header class="evidence-header">
      <span class="section-title">{{ rt("Context checkpoint") }}</span>
      <span v-if="checkpoint" class="checkpoint-id mono" data-testid="checkpoint-id" :title="checkpoint.checkpointId">
        {{ shortId(checkpoint.checkpointId) }}
      </span>
    </header>

    <form v-if="captureEvidence" class="evidence-capture" @submit.prevent="capture">
      <label class="capture-label">
        <span>{{ rt('Evidence kind') }}</span>
        <Dropdown :model-value="captureKind" :label="rt(captureKind === 'file' ? 'File' : 'Git diff')" :disabled="busy || capturing" auto-close @update:model-value="setCaptureKind">
          <DropdownItem value="file">{{ rt('File') }}</DropdownItem>
          <DropdownItem value="diff">{{ rt('Git diff') }}</DropdownItem>
        </Dropdown>
      </label>
      <label class="capture-label">
        <span>{{ rt('Evidence path') }}</span>
        <input v-model="capturePath" class="capture-path" required autocomplete="off" :disabled="busy || capturing" />
      </label>
      <button class="action-button" type="submit" :disabled="busy || capturing || !capturePath.trim()">{{ rt('Capture evidence') }}</button>
      <p class="evidence-empty">{{ rt('Selected evidence is included in the next handoff. File content is checked again before each preview.') }}</p>
    </form>
    <ul v-if="capturedEvidence.length" class="entry-list">
      <li v-for="record in capturedEvidence" :key="record.hash" class="entry-row">
        <span class="entry-origin">{{ originLabel(record.origin) }}</span>
        <span>{{ record.bytes }} B</span>
        <button v-if="removeEvidence" type="button" class="action-button" :disabled="busy || capturing" @click="removeEvidence(record.hash)">{{ rt('Remove from handoff') }}</button>
      </li>
    </ul>

    <p v-if="!checkpoint" class="evidence-empty" data-testid="checkpoint-empty">
      {{ rt("No checkpoint on this thread yet. A handoff mints the bounded context checkpoint that carries the goal, the plan, the decisions and the unresolved questions — never the transcript.") }}
    </p>

    <template v-else>
      <dl class="checkpoint-numbers">
        <div class="number-cell">
          <dt>{{ rt("Entries") }}</dt>
          <dd data-testid="checkpoint-entry-count">{{ checkpoint.entryCount }}</dd>
        </div>
        <div class="number-cell">
          <dt>{{ rt("Bytes") }}</dt>
          <dd data-testid="checkpoint-bytes">{{ checkpoint.bytes }}</dd>
        </div>
        <div class="number-cell">
          <dt>{{ rt("Est. tokens") }}</dt>
          <dd data-testid="checkpoint-tokens">{{ checkpoint.estimatedTokens }}</dd>
        </div>
        <div class="number-cell">
          <dt>{{ rt("Dropped") }}</dt>
          <dd data-testid="checkpoint-dropped">{{ checkpoint.droppedEntries }} {{ rt("entries /") }} {{ checkpoint.droppedBytes }} B</dd>
        </div>
        <div class="number-cell">
          <dt>{{ rt("Demoted") }}</dt>
          <dd data-testid="checkpoint-demoted">{{ checkpoint.demoted }}</dd>
        </div>
        <div class="number-cell">
          <dt>{{ rt("Untrusted") }}</dt>
          <dd data-testid="checkpoint-untrusted">{{ checkpoint.untrustedEntries }}</dd>
        </div>
        <div class="number-cell">
          <dt>{{ rt("Redactions") }}</dt>
          <dd data-testid="checkpoint-redactions">{{ checkpoint.redactions }}</dd>
        </div>
      </dl>

      <ul class="entry-list" data-testid="checkpoint-entries">
        <li
          v-for="entry in checkpoint.entries"
          :key="entry.entryId"
          class="entry-row"
          :data-testid="'checkpoint-entry'"
          :data-class="entry.class"
          :data-untrusted="String(entry.untrusted)"
        >
          <span class="entry-class" :data-class="entry.class">{{ rt(entry.class) }}</span>
          <span class="entry-origin">{{ originLabel(entry.origin) }}</span>
          <span v-if="entry.untrusted" class="entry-untrusted">
            {{ rt("untrusted:") }} <span data-testid="untrusted-reason">{{ entry.untrustedReason }}</span>
          </span>
          <span v-if="entry.redactions > 0" class="entry-redactions" data-testid="entry-redactions">
            {{ entry.redactions }} {{ rt("redacted") }}
          </span>
          <span class="entry-text" data-testid="entry-text">{{ entry.text ?? rt('(evidence reference)') }}</span>
          <span class="entry-hash mono" :title="entry.hash">{{ shortId(entry.hash) }}</span>
        </li>
      </ul>

      <div v-if="checkpoint.evidence.length > 0" class="evidence-section">
        <div class="section-title">{{ rt("Evidence") }}</div>
        <p class="evidence-hint">
          {{ rt("Evidence is addressed by hash and read by page from the CURRENT target: a stale snapshot is refused, never served.") }}
        </p>
        <ul class="evidence-list">
          <li
            v-for="ref in checkpoint.evidence"
            :key="ref.hash"
            class="evidence-row"
            :data-testid="'evidence-row'"
            :data-hash="ref.hash"
          >
            <span class="mono evidence-hash" :title="ref.hash">{{ shortId(ref.hash) }}</span>
            <span class="evidence-size">{{ ref.bytes }} B</span>
            <button
              type="button"
              class="action-button"
              :disabled="!canRead"
              :title="rt(canRead ? 'Read one byte page of this evidence' : 'No evidence reader is wired to this surface')"
              :data-testid="'read-evidence-page'"
              @click="readPage(ref)"
            >
              {{ rt("Read page") }}
            </button>
          </li>
        </ul>

        <div v-if="page" class="evidence-page" data-testid="evidence-page">
          <div class="page-meta">
            <span>{{ rt("offset") }} <span class="mono" data-testid="evidence-page-offset">{{ page.offset }}</span></span>
            <span>{{ rt("length") }} <span class="mono" data-testid="evidence-page-length">{{ page.length }}</span></span>
            <span>{{ rt("total") }} <span class="mono" data-testid="evidence-page-total">{{ page.totalBytes }}</span></span>
            <span v-if="page.nextOffset !== null" class="mono" data-testid="evidence-page-next">{{ page.nextOffset }}</span>
          </div>
          <pre class="page-text mono" data-testid="evidence-page-text">{{ decodedPage }}</pre>
          <button
            v-if="page.nextOffset !== null"
            type="button"
            class="action-button"
            :disabled="!canRead"
            data-testid="evidence-page-next-button"
            @click="readNext"
          >
            {{ rt("Next page") }}
          </button>
        </div>
        <div v-else-if="lastPage && lastPage.available === false" class="evidence-unavailable" data-testid="evidence-unavailable">
          {{ rt("This evidence is unavailable:") }} {{ rt(lastPage.unavailableReason) }}.
        </div>
      </div>
    </template>

    <p v-if="targetError" class="evidence-error" role="status">{{ rt(targetError) }}</p>
    <p v-if="pageError" class="evidence-error" role="alert" data-testid="evidence-error">
      {{ rt(pageError) }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { useRuntimeUi } from '../../locales/runtimeUi';
const { rt } = useRuntimeUi();
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { readEvidencePage as readLocalEvidencePage, type ContextCheckpointView, type EvidenceOrigin, type EvidencePageView, type EvidenceReader, type EvidenceRef, type EvidenceTarget } from '../../../shared/runtime/context.js';
import type { AsyncEvidencePageReader } from '../../runtime/hostEvidenceViews';
import type { AsyncEvidenceCapture } from '../../runtime/hostEvidenceViews';
import type { EvidenceRecordView } from '../../../shared/runtime/context.js';
import Dropdown from '../Dropdown.vue';
import DropdownItem from '../Dropdown/Item.vue';

const props = withDefaults(
  defineProps<{
    checkpoint: ContextCheckpointView | null;
    /** The CURRENT evidence target the reader re-verifies against. */
    currentTarget?: EvidenceTarget | null;
    targetError?: string;
    /** The injected reader that re-reads live bytes by hash. */
    readEvidence?: EvidenceReader | null;
    readEvidencePage?: AsyncEvidencePageReader | null;
    captureEvidence?: AsyncEvidenceCapture | null;
    capturedEvidence?: readonly EvidenceRecordView[];
    removeEvidence?: ((hash: string) => void) | null;
    busy?: boolean;
    /** Byte page size; the contract's own default applies when omitted. */
    pageLength?: number;
  }>(),
  { currentTarget: null, readEvidence: null, readEvidencePage: null, captureEvidence: null, capturedEvidence: () => [], removeEvidence: null, busy: false, pageLength: 4096 },
);

const page = ref<Extract<EvidencePageView, { available: true }> | null>(null);
const lastPage = ref<EvidencePageView | null>(null);
const pageError = ref('');
let lastRef: EvidenceRef | null = null;
let sequence = 0;
const loading = ref(false);
const captureKind = ref<'file' | 'diff'>('file');
const capturePath = ref('');
const capturing = ref(false);

function setCaptureKind(value: unknown): void { if (value === 'file' || value === 'diff') captureKind.value = value; }
async function capture(): Promise<void> {
  const capture = props.captureEvidence;
  if (!capture || props.busy || capturing.value || !capturePath.value.trim()) return;
  capturing.value = true;
  try {
    const record = await capture({ kind: captureKind.value, path: capturePath.value.trim() });
    if (record) capturePath.value = '';
  } catch (error) { pageError.value = error instanceof Error ? error.message : 'The evidence could not be captured.'; }
  finally { capturing.value = false; }
}

function resetPage(): void {
  sequence += 1; lastRef = null; page.value = null; lastPage.value = null; pageError.value = ''; loading.value = false;
}
watch([
  () => props.checkpoint?.checkpointId,
  () => props.checkpoint?.digest,
  () => props.currentTarget?.repoKey,
  () => props.currentTarget?.revision,
  () => props.readEvidence,
  () => props.readEvidencePage,
], resetPage);
onBeforeUnmount(resetPage);

const canRead = computed(() => !props.busy && !loading.value && (props.readEvidence !== null || props.readEvidencePage !== null) && props.currentTarget !== null);
const decoder = new TextDecoder();
const decodedPage = computed(() => (page.value === null ? '' : decoder.decode(page.value.bytes)));

async function readPage(ref: EvidenceRef, offset = 0): Promise<void> {
  const token = ++sequence;
  pageError.value = '';
  const reader = props.readEvidence;
  const target = props.currentTarget;
  if ((reader === null && props.readEvidencePage === null) || target === null) {
    pageError.value = 'No evidence reader is wired to this surface, so no byte can be served.';
    page.value = null;
    lastPage.value = null;
    return;
  }
  lastRef = ref;
  loading.value = true;
  try {
    const request = { ref, currentTarget: target, offset, length: props.pageLength };
    const next = props.readEvidencePage
      ? await props.readEvidencePage(request)
      : reader === null ? null : readLocalEvidencePage({ ...request, readEvidence: reader });
    if (token !== sequence || next === null) return;
    lastPage.value = next;
    page.value = next.available ? next : null;
  } catch (error) {
    if (token !== sequence) return;
    page.value = null;
    pageError.value = error instanceof Error ? error.message : 'The evidence page could not be read.';
  } finally {
    if (token === sequence) loading.value = false;
  }
}

function readNext(): void {
  if (page.value?.nextOffset == null || lastRef === null) return;
  readPage(lastRef, page.value.nextOffset);
}

function originLabel(origin: EvidenceOrigin): string {
  switch (origin.kind) {
    case 'host': return `${rt('host')}: ${origin.commandId}`;
    case 'native': return `${rt('native')}: ${origin.harness}`;
    case 'file': return `${rt('file')}: ${origin.path}`;
    case 'diff': return `${rt('diff')}: ${origin.path}`;
    default: return origin satisfies never;
  }
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}
</script>

<style scoped>
.evidence-capture, .capture-label { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.capture-path { padding: 6px 8px; min-height: 28px; border: 1px solid var(--ui-form-control-border); border-radius: var(--radius-control); }

.evidence-view {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--theme-border-subtle, var(--theme-border-muted, rgba(148, 163, 184, 0.18)));
  border-radius: var(--radius-panel, 10px);
  background: var(--theme-card-bg, var(--theme-surface-panel, rgba(30, 41, 59, 0.35)));
}

.evidence-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.section-title {
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--theme-text-muted, #94a3b8);
}

.checkpoint-id {
  margin-left: auto;
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
}

.evidence-empty {
  margin: 0;
  font-size: var(--type-sm, 12px);
  line-height: 1.45;
  color: var(--theme-text-muted, #94a3b8);
}

.checkpoint-numbers {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 6px 10px;
  margin: 0;
}

.number-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.number-cell dt {
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
}

.number-cell dd {
  margin: 0;
  font-size: var(--type-sm, 12px);
  font-weight: 600;
  color: var(--theme-text-primary, #e2e8f0);
}

.entry-list,
.evidence-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.entry-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  padding: 4px 8px;
  border: 1px solid var(--theme-border-default, #334155);
  border-radius: var(--radius-control, 8px);
  background: var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72));
  font-size: var(--type-caption, 10px);
}

.entry-class {
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--theme-border-default, #334155);
  color: var(--codex-status-info, var(--theme-text-primary));
}

.entry-class[data-class='unresolved'] {
  color: var(--codex-status-warning, var(--theme-text-primary));
}

.entry-origin,
.entry-hash {
  color: var(--theme-text-muted, #94a3b8);
}

.entry-untrusted {
  font-weight: 600;
  color: var(--codex-status-danger, var(--theme-text-primary));
}

.entry-redactions {
  color: var(--codex-status-warning, var(--theme-text-primary));
}

.entry-text {
  flex: 1 1 200px;
  min-width: 0;
  color: var(--theme-text-primary, #e2e8f0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.evidence-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.evidence-hint {
  margin: 0;
  font-size: var(--type-caption, 10px);
  line-height: 1.4;
  color: var(--theme-text-muted, #94a3b8);
}

.evidence-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: var(--type-caption, 10px);
}

.evidence-hash {
  color: var(--theme-text-muted, #94a3b8);
}

.evidence-size {
  color: var(--theme-text-muted, #94a3b8);
}

.evidence-page {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.page-meta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
}

.page-text {
  margin: 0;
  padding: 8px;
  max-height: 180px;
  overflow: auto;
  border: 1px solid var(--theme-border-default, #334155);
  border-radius: var(--radius-control, 8px);
  background: var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72));
  color: var(--theme-text-primary, #e2e8f0);
  font-size: var(--type-caption, 10px);
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-all;
}

.evidence-unavailable {
  margin: 0;
  font-size: var(--type-caption, 10px);
  color: var(--codex-status-warning, var(--theme-text-primary));
}

.evidence-error {
  margin: 0;
  font-size: var(--type-sm, 12px);
  line-height: 1.45;
  color: var(--codex-status-danger, var(--theme-text-primary));
  word-break: break-word;
}

.mono {
  font-family: var(--app-monospace-font-family);
}

.action-button {
  padding: 4px 10px;
  border: 1px solid var(--theme-form-control-border, var(--theme-border-default, #334155));
  border-radius: var(--radius-control, 8px);
  background: transparent;
  color: var(--theme-text-primary, #e2e8f0);
  font-family: inherit;
  font-size: var(--type-caption, 10px);
  cursor: pointer;
}

.action-button:hover:not(:disabled) {
  background: var(--theme-surface-panel-hover, rgba(15, 23, 42, 0.9));
}

.action-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.action-button:focus-visible {
  outline: 2px solid var(--theme-accent-primary, #60a5fa);
  outline-offset: 1px;
}
</style>
