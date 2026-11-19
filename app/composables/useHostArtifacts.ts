import { computed, ref, type Ref } from 'vue';
import { ProtocolError } from '../../shared/runtime/capabilities.js';
import type { HostClient } from '../runtime/hostClient';
import { hostArray, hostDeliverable, hostObject, hostString } from '../runtime/hostCollaborationViews';
import { artifactContent, artifactIntegration, artifactReview } from '../runtime/hostArtifactViews';
import type { ArtifactAction, ArtifactContentView, ArtifactEntryView, ArtifactIntegrationView, ArtifactReviewView, ArtifactTestSpec, ArtifactWorkflowView } from '../runtime/hostArtifactViews';
import type { CollaborationTaskView } from './useRuntimeCollaboration';

type ArtifactContext = {
  readonly selectedTaskId: Ref<string | null>;
  readonly error: Ref<string>;
  readonly task: (taskId: string) => CollaborationTaskView | null;
  readonly leaseId: (taskId: string) => string | null;
  readonly current: (host: HostClient, token: number) => boolean;
  readonly run: (action: (host: HostClient, token: number) => Promise<void>) => Promise<void>;
  readonly refresh: (host: HostClient, token: number) => Promise<void>;
};

export function createHostArtifactState(context: ArtifactContext) {
  const review = ref<ArtifactReviewView | null>(null);
  const approvalId = ref<string | null>(null);
  const integration = ref<ArtifactIntegrationView | null>(null);
  const artifactHash = ref<string | null>(null);
  const entries = ref<readonly ArtifactEntryView[]>([]);
  const content = ref<ArtifactContentView | null>(null);
  const status = ref('');
  const entryPage = ref<{ offset: number; nextCursor: number | null; total: number }>({ offset: 0, nextCursor: null, total: 0 });

  function requireArtifact(taskId: string, hash: string): CollaborationTaskView {
    const task = context.task(taskId);
    if (!task?.deliverables.some((deliverable) => deliverable.artifactHash === hash)) throw new ProtocolError('unauthorized', 'artifact.task');
    return task;
  }

  function selected(host: HostClient, token: number, taskId: string, hash: string): boolean {
    return context.current(host, token) && context.selectedTaskId.value === taskId && artifactHash.value === hash;
  }

  function reset(): void {
    review.value = null; approvalId.value = null; integration.value = null;
    artifactHash.value = null; entries.value = []; content.value = null; status.value = '';
    entryPage.value = { offset: 0, nextCursor: null, total: 0 };
  }

  function acceptEntries(listing: ReturnType<typeof hostObject>): void {
    const page = hostObject(listing.pagination);
    const counts = hostObject(page.counts);
    if (typeof page.offset !== 'number' || typeof counts.entries !== 'number' ||
      !(page.cursor === null || typeof page.cursor === 'number')) throw new ProtocolError('invalid_request', 'artifact.entry_page');
    entryPage.value = { offset: page.offset, nextCursor: page.cursor, total: counts.entries };
    entries.value = hostArray(listing.entries).map((value) => {
      const raw = hostObject(value); return { path: hostString(raw.path), kind: hostString(raw.kind) };
    });
  }

  async function captureDeliverable(taskId: string): Promise<void> {
    const leaseId = context.leaseId(taskId);
    if (!leaseId || !context.task(taskId)) { context.error.value = 'Allocate a writer for this task before capturing changes.'; return; }
    await context.run(async (host, token) => {
      const captured = await host.mutate({ domain: 'artifact', operation: 'capture', args: { leaseId } }, hostObject, crypto.randomUUID()).executed;
      const deliverable = hostDeliverable({ deliverableId: crypto.randomUUID(), artifactHash: captured.artifactHash, bytes: captured.bytes, paths: captured.paths });
      await host.mutate({ domain: 'collaboration', operation: 'registerDeliverable', args: { taskId, deliverable } }, (value) => value, crypto.randomUUID()).executed;
      await context.refresh(host, token);
    });
  }

  async function inspectArtifact(taskId: string, hash: string): Promise<void> {
    reset(); artifactHash.value = hash;
    await context.run(async (host, token) => {
      requireArtifact(taskId, hash);
      const [listing, workflow] = await Promise.all([
        host.read({ domain: 'artifact', operation: 'entries', args: { artifactHash: hash, limit: 50 } }, hostObject),
        host.read({ domain: 'artifact', operation: 'workflow', args: { artifactHash: hash, limit: 50 } }, hostObject),
      ]);
      if (!selected(host, token, taskId, hash)) return;
      acceptEntries(listing);
      const current = hostObject(workflow.current);
      review.value = current.review === null ? null : artifactReview(current.review);
      if (review.value && review.value.taskId !== taskId) throw new ProtocolError('unauthorized', 'artifact.workflow_task');
      const approval = current.approval === null ? null : hostObject(current.approval);
      approvalId.value = approval ? hostString(approval.approvalId) : null;
      const result = current.integration === null ? null : hostObject(current.integration);
      integration.value = result ? artifactIntegration(result) : null;
    });
  }

  async function readContent(taskId: string, hash: string, path: string, offset = 0): Promise<void> {
    await context.run(async (host, token) => {
      requireArtifact(taskId, hash);
      const value = await host.read({ domain: 'artifact', operation: 'content', args: { artifactHash: hash, path, offset, limit: 65536 } }, artifactContent);
      if (selected(host, token, taskId, hash)) content.value = value;
    });
  }

  async function loadEntryPage(offset: number): Promise<void> {
    const taskId = context.selectedTaskId.value, hash = artifactHash.value;
    if (!taskId || !hash) return;
    await context.run(async (host, token) => {
      requireArtifact(taskId, hash);
      const listing = await host.read({ domain: 'artifact', operation: 'entries', args: { artifactHash: hash, cursor: offset, limit: 50 } }, hostObject);
      if (selected(host, token, taskId, hash)) acceptEntries(listing);
    });
  }

  async function prepareReview(input: { taskId: string; artifactHash: string; repository: string; target: string }): Promise<void> {
    await context.run(async (host, token) => {
      requireArtifact(input.taskId, input.artifactHash);
      const value = await host.mutate({ domain: 'artifact', operation: 'review', args: {
        artifactHash: input.artifactHash, repository: input.repository, target: input.target,
      } }, artifactReview, crypto.randomUUID()).executed;
      if (value.taskId !== input.taskId || value.artifactHash !== input.artifactHash) throw new ProtocolError('unauthorized', 'artifact.review_binding');
      if (context.current(host, token) && context.selectedTaskId.value === input.taskId) {
        artifactHash.value = input.artifactHash; review.value = value; approvalId.value = null; integration.value = null;
      }
    });
  }

  async function approveIntegration(reviewId: string): Promise<void> {
    const captured = review.value;
    if (!captured || captured.reviewId !== reviewId) { context.error.value = 'Prepare and inspect the current artifact review first.'; return; }
    await context.run(async (host, token) => {
      const approved = await host.mutate({ domain: 'artifact', operation: 'approve', args: { reviewId } }, hostObject, crypto.randomUUID()).executed;
      if (approved.reviewId !== reviewId || approved.artifactHash !== captured.artifactHash) throw new ProtocolError('unauthorized', 'artifact.approval_binding');
      if (selected(host, token, captured.taskId, captured.artifactHash)) {
        approvalId.value = hostString(approved.approvalId);
        review.value = { ...captured, state: 'approved' };
      }
    });
  }

  async function integrate(input: { approvalId: string; tests: readonly ArtifactTestSpec[]; commitMessage?: string }): Promise<void> {
    const captured = review.value;
    if (!captured || input.approvalId !== approvalId.value) { context.error.value = 'Approve the current artifact review first.'; return; }
    await context.run(async (host, token) => {
      const result = await host.mutate({ domain: 'artifact', operation: 'integrate', args: input }, artifactIntegration, crypto.randomUUID()).executed;
      if (selected(host, token, captured.taskId, captured.artifactHash)) integration.value = result;
      await context.refresh(host, token);
    });
  }

  async function applyArtifact(input: { taskId: string; artifactHash: string; target: string; dryRun: boolean }): Promise<void> {
    if (!input.dryRun) { context.error.value = 'Prepare an artifact review and run its acceptance tests before integration.'; return; }
    await context.run(async (host, token) => {
      requireArtifact(input.taskId, input.artifactHash);
      await host.mutate({ domain: 'artifact', operation: 'apply', args: { artifactHash: input.artifactHash, target: input.target, dryRun: true } }, hostObject, crypto.randomUUID()).executed;
      if (context.current(host, token) && context.selectedTaskId.value === input.taskId) status.value = 'The Bridge verified the captured change against the target repository.';
    });
  }

  async function handleAction(action: ArtifactAction): Promise<void> {
    switch (action.type) {
      case 'inspect': return inspectArtifact(action.taskId, action.artifactHash);
      case 'entries-page': return loadEntryPage(action.offset);
      case 'read': return readContent(action.taskId, action.artifactHash, action.path, action.offset);
      case 'prepare': return prepareReview(action);
      case 'approve': return approveIntegration(action.reviewId);
      case 'integrate': return integrate(action);
      default: action satisfies never;
    }
  }

  const presentation = computed<ArtifactWorkflowView>(() => ({
    artifactHash: artifactHash.value, review: review.value, approvalId: approvalId.value,
    integration: integration.value, entries: entries.value, content: content.value, entryPage: entryPage.value,
  }));
  return { review, approvalId, integration, artifactHash, entries, content, status, presentation, reset, captureDeliverable, inspectArtifact, readContent, prepareReview, approveIntegration, integrate, applyArtifact, handleAction };
}
