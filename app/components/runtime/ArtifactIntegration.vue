<template>
  <section class="artifact-integration" data-runtime-ui :aria-label='rt("Integrate captured change")'>
    <Dropdown v-model="selectedId" :label="selected?.artifactHash.slice(0, 12) ?? rt('Captured deliverable')" :aria-label='rt("Captured deliverable")' auto-close :disabled="busy">
      <template #value>{{ selected?.artifactHash.slice(0, 12) }}</template>
      <DropdownItem v-for="deliverable in task.deliverables" :key="deliverable.deliverableId" :value="deliverable.deliverableId">
        {{ deliverable.artifactHash.slice(0, 12) }} · {{ deliverable.paths.join(', ') }}
      </DropdownItem>
    </Dropdown>

    <ul v-if="workflow?.entries.length" class="entry-list">
      <li v-for="entry in workflow.entries" :key="entry.path">
        <button type="button" class="action-button" :disabled="busy" @click="read(entry.path)">{{ entry.path }}</button>
        <span>{{ rt(entry.kind) }}</span>
      </li>
    </ul>
    <nav v-if="workflow && workflow.entryPage.total > 50" class="entry-pagination" :aria-label='rt("Captured files pages")'>
      <button type="button" class="action-button" :disabled="busy || workflow.entryPage.offset === 0" @click="emit('action', { type: 'entries-page', offset: Math.max(0, workflow.entryPage.offset - 50) })">{{ rt("Previous files") }}</button>
      <span>{{ workflow.entryPage.offset + 1 }}–{{ Math.min(workflow.entryPage.offset + 50, workflow.entryPage.total) }} / {{ workflow.entryPage.total }}</span>
      <button type="button" class="action-button" :disabled="busy || workflow.entryPage.nextCursor === null" @click="emit('action', { type: 'entries-page', offset: workflow.entryPage.nextCursor ?? 0 })">{{ rt("Next files") }}</button>
    </nav>
    <div v-if="workflow?.content" class="artifact-content">
      <div>{{ workflow.content.path }} · {{ workflow.content.totalBytes }} {{ rt("bytes") }}</div>
      <p v-if="workflow.content.binary">{{ rt("Binary content") }}</p>
      <pre v-else tabindex="0">{{ workflow.content.text }}</pre>
      <button v-if="workflow.content.nextOffset !== null" type="button" class="action-button" :disabled="busy" @click="read(workflow.content.path, workflow.content.nextOffset)">{{ rt("Next section") }}</button>
    </div>

    <form class="integration-form" @submit.prevent="prepare">
      <label>{{ rt("Target repository path") }}<input v-model="repository" required :disabled="busy" autocomplete="off" /></label>
      <label>{{ rt("Target branch") }}<input v-model="branch" required :disabled="busy" autocomplete="off" /></label>
      <p>{{ rt("Choose an existing integration branch that is not checked out in any worktree.") }}</p>
      <p v-if="!reviewApproved">{{ rt("Approve the current artifact review first.") }}</p>
      <button type="submit" class="action-button" data-testid="prepare-artifact-review" :disabled="busy || !reviewApproved || !selected || !repository.trim() || !branch.trim()">{{ rt("Prepare integration review") }}</button>
    </form>

    <div v-if="workflow?.review" class="integration-review">
      <p>{{ rt("Review {artifact} against {target} at {base}.", { artifact: workflow.review.artifactHash.slice(0, 12), target: workflow.review.target, base: workflow.review.base.slice(0, 12) }) }}</p>
      <label class="confirmation"><input v-model="confirmed" type="checkbox" :disabled="busy || !!workflow.approvalId" />{{ rt("I have reviewed the captured changes.") }}</label>
      <button type="button" class="action-button" :disabled="busy || !confirmed || !!workflow.approvalId" @click="emit('action', { type: 'approve', reviewId: workflow.review.reviewId })">{{ rt("Approve captured change") }}</button>
    </div>

    <form v-if="workflow?.approvalId" class="integration-form" @submit.prevent="integrate">
      <fieldset v-for="criterion in task.criteria" :key="criterion.id">
        <legend>{{ criterion.text }}{{ criterion.required ? ' *' : '' }}</legend>
        <label>{{ rt("Test executable") }}<input :value="drafts[criterion.id]?.command ?? ''" :disabled="busy" :required="criterion.required" @input="edit(criterion.id, 'command', $event)" autocomplete="off" /></label>
        <label>{{ rt("Arguments (one per line)") }}<textarea :value="drafts[criterion.id]?.args ?? ''" :disabled="busy" rows="2" @input="edit(criterion.id, 'args', $event)" /></label>
      </fieldset>
      <label>{{ rt("Commit message") }}<input v-model="commitMessage" :disabled="busy" /></label>
      <p>{{ rt("The Bridge applies the artifact and runs these tests in an isolated worktree. A passing result can fast-forward the reviewed branch.") }}</p>
      <button class="action-button save" type="submit" data-testid="integrate-reviewed-artifact" :disabled="busy || !testsReady">{{ rt("Run tests and integrate") }}</button>
    </form>

    <div v-if="workflow?.integration" role="status" class="integration-result">
      <strong>{{ rt(workflow.integration.outcome) }}</strong>
      <p v-if="workflow.integration.rejection">{{ rt(workflow.integration.rejection) }}</p>
      <p v-if="workflow.integration.commit">{{ rt("Commit:") }} {{ workflow.integration.commit }}</p>
      <ul><li v-for="test in workflow.integration.tests" :key="test.criterionId">{{ test.criterionId }} {{ rt("· exit") }} {{ test.exitCode }} · {{ test.durationMs }} ms</li></ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useRuntimeUi } from '../../locales/runtimeUi';
const { rt } = useRuntimeUi();
import { computed, ref, watch } from 'vue';
import Dropdown from '../Dropdown.vue';
import DropdownItem from '../Dropdown/Item.vue';
import type { ArtifactAction, ArtifactTestSpec, ArtifactWorkflowView } from '../../runtime/hostArtifactViews';
import type { CollaborationTaskView } from '../../composables/useRuntimeCollaboration';

const props = defineProps<{ task: CollaborationTaskView; workflow?: ArtifactWorkflowView; busy?: boolean }>();
const emit = defineEmits<{ action: [action: ArtifactAction] }>();
const selectedId = ref<string>();
const reviewApproved = computed(() => props.task.review.state === 'approved');
const selected = computed(() => props.task.deliverables.find((value) => value.deliverableId === selectedId.value) ?? props.task.deliverables[0]);
const workflow = computed(() => props.workflow?.artifactHash === selected.value?.artifactHash ? props.workflow : undefined);
const repository = ref('');
const branch = ref('');
const confirmed = ref(false);
const commitMessage = ref('');
const drafts = ref<Readonly<Record<string, { readonly command: string; readonly args: string }>>>({});
const testsReady = computed(() => props.task.criteria.every((criterion) => !criterion.required || Boolean(drafts.value[criterion.id]?.command.trim())));

watch(() => selected.value?.artifactHash, (hash) => {
  confirmed.value = false;
  if (hash) emit('action', { type: 'inspect', taskId: props.task.taskId, artifactHash: hash });
}, { immediate: true });
watch(() => props.task.taskId, () => { drafts.value = {}; selectedId.value = undefined; repository.value = ''; branch.value = ''; commitMessage.value = ''; });
watch(() => props.workflow?.review?.reviewId, () => {
  confirmed.value = false;
  if (workflow.value?.review) { repository.value = workflow.value.review.repository; branch.value = workflow.value.review.target; }
});

function edit(id: string, key: 'command' | 'args', event: Event): void {
  if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) return;
  const previous = drafts.value[id] ?? { command: '', args: '' };
  drafts.value = { ...drafts.value, [id]: { ...previous, [key]: event.target.value } };
}
function read(path: string, offset = 0): void {
  if (selected.value) emit('action', { type: 'read', taskId: props.task.taskId, artifactHash: selected.value.artifactHash, path, offset });
}
function prepare(): void {
  if (props.busy || !reviewApproved.value || !selected.value || !repository.value.trim() || !branch.value.trim()) return;
  emit('action', { type: 'prepare', taskId: props.task.taskId, artifactHash: selected.value.artifactHash, repository: repository.value.trim(), target: branch.value.trim() });
}
function integrate(): void {
  if (props.busy || !workflow.value?.approvalId || !testsReady.value) return;
  const tests: ArtifactTestSpec[] = props.task.criteria.flatMap((criterion) => {
    const draft = drafts.value[criterion.id];
    return draft?.command.trim() ? [{ criterionId: criterion.id, command: draft.command.trim(), args: draft.args.split('\n').filter((arg) => arg.length > 0) }] : [];
  });
  emit('action', { type: 'integrate', approvalId: workflow.value.approvalId, tests, ...(commitMessage.value.trim() ? { commitMessage: commitMessage.value.trim() } : {}) });
}
</script>

<style scoped>
.artifact-integration, .integration-form, .integration-review, fieldset, label { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.artifact-integration { font-size: var(--type-sm); color: var(--theme-text-primary); }
input, textarea { border: 1px solid var(--ui-form-control-border); border-radius: var(--radius-control); padding: 4px 8px; min-height: 28px; width: 100%; box-sizing: border-box; background: var(--ui-form-control-bg); color: var(--ui-form-control-text); }
fieldset { margin: 0; padding: 8px; border: 1px solid var(--theme-border-default); border-radius: var(--radius-control); }
.confirmation { flex-direction: row; align-items: start; }
.confirmation input { width: auto; min-height: auto; }
.entry-list { padding: 0; margin: 0; list-style: none; }
.entry-list li { display: flex; gap: 8px; align-items: center; overflow-wrap: anywhere; }
.artifact-content pre { max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 8px; background: var(--theme-surface-panel-muted); border: 1px solid var(--theme-border-default); }
.integration-result { overflow-wrap: anywhere; }
.entry-pagination { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.action-button { border: 1px solid var(--ui-form-button-border); border-radius: var(--radius-control); padding: 4px 8px; background: var(--ui-form-button-bg); color: var(--ui-form-button-text); }
</style>
