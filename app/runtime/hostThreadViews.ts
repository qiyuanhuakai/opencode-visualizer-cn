import { ProtocolError } from '../../shared/runtime/capabilities.js';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef, decodeWorkspaceKey, encodeWorkspaceKey } from '../../shared/runtime/identity.js';
import { validateHarnessManifest } from '../../shared/runtime/harnessContract.js';
import { parseParticipantId, parseParticipantState, parseThreadId, parseThreadRole } from '../../shared/runtime/thread.js';
import type { ThreadSummary } from '../../bridge/runtime/threads/threadService.js';
import type { RuntimeHandoffView, RuntimeHandoffOpView } from '../composables/useRuntimeThread';
import { parseTimelineSource, TIMELINE_ENTRY_KINDS } from './timeline';
import type { TimelinePage, TimelineEntryKind } from './timeline';
import { hostArray, hostObject, hostString } from './hostCollaborationViews';

function nullable(value: unknown): string | null { return value === null ? null : hostString(value); }
export function hostSessionSelection(value: unknown) {
  const row = hostObject(value), session = parseSessionRef(row.session), manifest = validateHarnessManifest(row.manifest);
  if (session.environmentId !== manifest.environmentId || session.harnessInstanceId !== manifest.harnessInstanceId) throw new ProtocolError('invalid_request', 'host.selection_identity');
  const workspace = row.workspaceKey === null ? null : decodeWorkspaceKey(hostString(row.workspaceKey));
  if (workspace && workspace.environmentId !== session.environmentId) throw new ProtocolError('invalid_request', 'host.selection_workspace');
  const directory = nullable(row.directory);
  if (directory && directory.length > 16384) throw new ProtocolError('invalid_request', 'host.selection_directory');
  const title = row.title === undefined ? undefined : hostString(row.title);
  const status = row.status === undefined ? undefined : nullable(row.status);
  if (row.archived !== undefined && typeof row.archived !== 'boolean') throw new ProtocolError('invalid_request', 'host.selection_archived');
  if (title && title.length > 8192 || status && status.length > 128) throw new ProtocolError('invalid_request', 'host.selection_label');
  return { session, manifest, directory, workspaceKey: workspace ? encodeWorkspaceKey(workspace) : null, ...(title === undefined ? {} : { title }), ...(status === undefined ? {} : { status }), ...(typeof row.archived === 'boolean' ? { archived: row.archived } : {}) };
}
function numeric(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ProtocolError('invalid_request', 'host.result.number');
  return value;
}
function at(value: unknown): number | null { return value === null ? null : numeric(value); }
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ProtocolError('invalid_request', 'host.result.flag');
  return value;
}

export function hostParticipant(value: unknown): ThreadSummary['participants'][number] {
  const member = hostObject(value);
  return {
    participantId: parseParticipantId(member.participantId), role: parseThreadRole(member.role),
    state: parseParticipantState(member.state), session: parseSessionRef(member.session),
    nativeParent: member.nativeParent === null ? null : parseSessionRef(member.nativeParent),
    harnessInstanceId: parseHarnessInstanceId(member.harnessInstanceId),
  };
}

export function hostThread(value: unknown): ThreadSummary {
  const raw = hostObject(value);
  return {
    threadId: parseThreadId(raw.threadId), environmentId: parseEnvironmentId(raw.environmentId),
    repoKey: hostString(raw.repoKey), revision: numeric(raw.revision),
    activeParticipantId: raw.activeParticipantId === null ? null : parseParticipantId(raw.activeParticipantId),
    harnessInstanceIds: hostArray(raw.harnessInstanceIds).map(parseHarnessInstanceId),
    participants: hostArray(raw.participants).map(hostParticipant),
  };
}

export function hostHandoff(value: unknown): RuntimeHandoffView {
  const raw = hostObject(value);
  function participant(value: unknown) {
    const raw = hostObject(value);
    return { participantId: hostString(raw.participantId), session: parseSessionRef(raw.session) };
  }
  const checkpoint = raw.checkpoint === null ? null : hostObject(raw.checkpoint);
  const resolution = raw.resolution === null ? null : hostObject(raw.resolution);
  return {
    handoffId: hostString(raw.handoffId), threadId: hostString(raw.threadId), environmentId: hostString(raw.environmentId),
    state: hostString(raw.state), active: flag(raw.active), source: participant(raw.source), target: participant(raw.target),
    originalParticipantId: hostString(raw.originalParticipantId),
    checkpoint: checkpoint === null ? null : {
      checkpointId: hostString(checkpoint.checkpointId), digest: hostString(checkpoint.digest),
      bytes: numeric(checkpoint.bytes), entryCount: numeric(checkpoint.entryCount),
    },
    promptFingerprint: nullable(raw.promptFingerprint), delivered: flag(raw.delivered), deliveredAt: at(raw.deliveredAt),
    deliveredBy: nullable(raw.deliveredBy), observed: flag(raw.observed), observedAt: at(raw.observedAt), observedBy: nullable(raw.observedBy),
    resolution: resolution === null ? null : {
      resolution: hostString(resolution.resolution), code: hostString(resolution.code), field: hostString(resolution.field),
      reason: nullable(resolution.reason), at: numeric(resolution.at),
    },
    sends: numeric(raw.sends), createdAt: numeric(raw.createdAt), updatedAt: numeric(raw.updatedAt),
  };
}

export function hostHandoffOps(value: unknown): readonly RuntimeHandoffOpView[] {
  return hostArray(value).map((value) => {
    const raw = hostObject(value);
    return {
      opId: hostString(raw.opId), handoffId: hostString(raw.handoffId), kind: hostString(raw.kind), at: numeric(raw.at),
      applied: flag(raw.applied), duplicate: flag(raw.duplicate), outcome: hostString(raw.outcome),
      code: nullable(raw.code), field: nullable(raw.field),
    };
  });
}

function entryKind(value: unknown): TimelineEntryKind {
  const kind = TIMELINE_ENTRY_KINDS.find((kind) => kind === value);
  if (kind === undefined) throw new ProtocolError('invalid_request', 'host.timeline.kind');
  return kind;
}

export function hostTimeline(value: unknown): TimelinePage {
  const raw = hostObject(value);
  return {
    nextCursor: raw.nextCursor === null ? null : numeric(raw.nextCursor), total: numeric(raw.total),
    entries: hostArray(raw.entries).map((value) => {
      const raw = hostObject(value);
      return {
        entryId: hostString(raw.entryId), order: numeric(raw.order), seq: numeric(raw.seq), turnId: hostString(raw.turnId),
        kind: entryKind(raw.kind), source: parseTimelineSource(raw.source), at: numeric(raw.at),
        payload: hostObject(raw.payload), late: flag(raw.late), dedupKey: hostString(raw.dedupKey),
      };
    }),
  };
}
