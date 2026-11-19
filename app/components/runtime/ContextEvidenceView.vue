<template>
  <section class="evidence-view" data-testid="context-evidence-view" :aria-label="'Context checkpoint and evidence'">
    <header class="evidence-header">
      <span class="section-title">Context checkpoint</span>
      <span v-if="checkpoint" class="checkpoint-id mono" data-testid="checkpoint-id" :title="checkpoint.checkpointId">
        {{ shortId(checkpoint.checkpointId) }}
      </span>
    </header>

    <p v-if="!checkpoint" class="evidence-empty" data-testid="checkpoint-empty">
      No checkpoint on this thread yet. A handoff mints the bounded context checkpoint that carries
      the goal, the plan, the decisions and the unresolved questions — never the transcript.
    </p>

    <template v-else>
      <dl class="checkpoint-numbers">
        <div class="number-cell">
          <dt>Entries</dt>
          <dd data-testid="checkpoint-entry-count">{{ checkpoint.entryCount }}</dd>
        </div>
        <div class="number-cell">
          <dt>Bytes</dt>
          <dd data-testid="checkpoint-bytes">{{ checkpoint.bytes }}</dd>
        </div>
        <div class="number-cell">
          <dt>Est. tokens</dt>
          <dd data-testid="checkpoint-tokens">{{ checkpoint.estimatedTokens }}</dd>
        </div>
        <div class="number-cell">
          <dt>Dropped</dt>
          <dd data-testid="checkpoint-dropped">{{ checkpoint.droppedEntries }} entries / {{ checkpoint.droppedBytes }} B</dd>
        </div>
        <div class="number-cell">
          <dt>Demoted</dt>
          <dd data-testid="checkpoint-demoted">{{ checkpoint.demoted }}</dd>
        </div>
        <div class="number-cell">
          <dt>Untrusted</dt>
          <dd data-testid="checkpoint-untrusted">{{ checkpoint.untrustedEntries }}</dd>
        </div>
        <div class="number-cell">
          <dt>Redactions</dt>
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
          <span class="entry-class" :data-class="entry.class">{{ entry.class }}</span>
          <span class="entry-origin">{{ originLabel(entry.origin) }}</span>
          <span v-if="entry.untrusted" class="entry-untrusted">
            untrusted: <span data-testid="untrusted-reason">{{ entry.untrustedReason }}</span>
          </span>
          <span v-if="entry.redactions > 0" class="entry-redactions" data-testid="entry-redactions">
            {{ entry.redactions }} redacted
          </span>
          <span class="entry-text" data-testid="entry-text">{{ entry.text ?? '(evidence reference)' }}</span>
          <span class="entry-hash mono" :title="entry.hash">{{ shortId(entry.hash) }}</span>
        </li>
      </ul>

      <div v-if="checkpoint.evidence.length > 0" class="evidence-section">
        <div class="section-title">Evidence</div>
        <p class="evidence-hint">
          Evidence is addressed by hash and read by page from the CURRENT target: a stale snapshot is
          refused, never served.
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
              :title="canRead ? 'Read one byte page of this evidence' : 'No evidence reader is wired to this surface'"
              :data-testid="'read-evidence-page'"
              @click="readPage(ref)"
            >
              Read page
            </button>
          </li>
        </ul>

        <div v-if="page" class="evidence-page" data-testid="evidence-page">
          <div class="page-meta">
            <span>offset <span class="mono" data-testid="evidence-page-offset">{{ page.offset }}</span></span>
            <span>length <span class="mono" data-testid="evidence-page-length">{{ page.length }}</span></span>
            <span>total <span class="mono" data-testid="evidence-page-total">{{ page.totalBytes }}</span></span>
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
            Next page
          </button>
        </div>
        <div v-else-if="lastPage && lastPage.available === false" class="evidence-unavailable" data-testid="evidence-unavailable">
          This evidence is unavailable: {{ lastPage.unavailableReason }}.
        </div>
      </div>
    </template>

    <p v-if="pageError" class="evidence-error" role="alert" data-testid="evidence-error">
      {{ pageError }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { readEvidencePage, type ContextCheckpointView, type EvidencePageView, type EvidenceReader, type EvidenceRef, type EvidenceTarget } from '../../../shared/runtime/context.js';

/**
 * Task 35 — the checkpoint preview and the evidence query.
 *
 * The page read goes through the contract's OWN `readEvidencePage` (shared/runtime/context.js),
 * which re-verifies the recorded target against the CURRENT one, re-hashes the live bytes and
 * only then slices. It is called directly rather than through the MCP dispatcher on purpose: the
 * dispatcher's frozen TOOL_ARGUMENT_KEYS accepts only [checkpointId, scope, hash], so a second
 * harness could only ever obtain the FIRST page through it — a carried-forward task-33 gap this
 * surface must not inherit. A stale target or changed bytes throw, and the throw is rendered as a
 * readable refusal; a missing artifact is reported unavailable, never fabricated.
 */
const props = withDefaults(
  defineProps<{
    checkpoint: ContextCheckpointView | null;
    /** The CURRENT evidence target the reader re-verifies against. */
    currentTarget?: EvidenceTarget | null;
    /** The injected reader that re-reads live bytes by hash. */
    readEvidence?: EvidenceReader | null;
    /** Byte page size; the contract's own default applies when omitted. */
    pageLength?: number;
  }>(),
  { currentTarget: null, readEvidence: null, pageLength: 4096 },
);

const page = ref<Extract<EvidencePageView, { available: true }> | null>(null);
const lastPage = ref<EvidencePageView | null>(null);
const pageError = ref('');
let lastRef: EvidenceRef | null = null;

/**
 * The cached page is scoped to the exact boundary it was read through. Any change of checkpoint,
 * current target or reader makes the held bytes stale, so the cache is dropped rather than shown
 * under a different scope.
 */
function resetPage(): void {
  page.value = null;
  lastPage.value = null;
  pageError.value = '';
  lastRef = null;
}

/**
 * The cached page is scoped to the exact boundary it was read through. Any change of checkpoint,
 * current target or reader makes the held bytes stale, so the cache is dropped rather than shown
 * under a different scope. The target's boundary is its IDENTITY — repoKey and revision — read as
 * scalars, because a live target can be revised in place (the same object, a new revision) and a
 * reference watch would never fire for that.
 */
watch(
  () => [
    props.checkpoint?.checkpointId ?? null,
    props.currentTarget?.repoKey ?? null,
    props.currentTarget?.revision ?? null,
    props.readEvidence,
  ] as const,
  () => { resetPage(); },
);

const canRead = computed(() => props.readEvidence !== null && props.currentTarget !== null);
const decoder = new TextDecoder();
const decodedPage = computed(() => (page.value === null ? '' : decoder.decode(page.value.bytes)));

function readPage(ref: EvidenceRef, offset = 0): void {
  pageError.value = '';
  const reader = props.readEvidence;
  const target = props.currentTarget;
  if (reader === null || target === null) {
    pageError.value = 'No evidence reader is wired to this surface, so no byte can be served.';
    page.value = null;
    lastPage.value = null;
    return;
  }
  lastRef = ref;
  try {
    const next = readEvidencePage({
      ref,
      currentTarget: target,
      readEvidence: reader,
      offset,
      length: props.pageLength,
    });
    lastPage.value = next;
    page.value = next.available ? next : null;
  } catch (error) {
    page.value = null;
    pageError.value = error instanceof Error ? `${error.message} (${String((error as { code?: string }).code ?? '')})` : 'The evidence page could not be read.';
  }
}

function readNext(): void {
  if (page.value?.nextOffset == null || lastRef === null) return;
  readPage(lastRef, page.value.nextOffset);
}

function originLabel(origin: unknown): string {
  if (origin === null || typeof origin !== 'object') return 'unknown';
  const record = origin as Record<string, unknown>;
  if (record.kind === 'host') return `host:${String(record.commandId ?? '')}`;
  if (record.kind === 'native') return `native:${String(record.harness ?? '')}`;
  if (record.kind === 'file') return `file:${String(record.path ?? '')}`;
  if (record.kind === 'diff') return `diff:${String(record.path ?? '')}`;
  return 'unknown';
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}
</script>

<style scoped>
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
  color: var(--theme-status-info, #7dd3fc);
}

.entry-class[data-class='unresolved'] {
  color: var(--theme-status-warning, #fcd34d);
}

.entry-origin,
.entry-hash {
  color: var(--theme-text-muted, #94a3b8);
}

.entry-untrusted {
  font-weight: 600;
  color: var(--theme-status-error, #f87171);
}

.entry-redactions {
  color: var(--theme-status-warning, #fcd34d);
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
  color: var(--theme-status-warning, #fcd34d);
}

.evidence-error {
  margin: 0;
  font-size: var(--type-sm, 12px);
  line-height: 1.45;
  color: var(--theme-status-error, #f87171);
  word-break: break-word;
}

.mono {
  font-family: var(--app-monospace-font-family);
}

.action-button {
  padding: 4px 10px;
  border: 1px solid var(--theme-input-border, var(--theme-border-default, #334155));
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
