import type {
  ProjectInfo,
  SessionInfo,
  SessionStatusInfo,
  SsePacket,
  WorkerStateEventMap,
  WorkerStateEventType,
  WorkerStatePacket,
} from '../types/sse';

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asObjectArray<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value as T[];
}

export function asStatusMap(value: unknown): Record<string, { type?: string }> {
  const record = asRecord(value);
  if (!record) return {};
  return record as Record<string, { type?: string }>;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    values.push(item);
  }
  return values;
}

function asStringMatrix(value: unknown): string[][] | null {
  if (!Array.isArray(value)) return null;
  const rows: string[][] = [];
  for (const row of value) {
    const parsed = asStringArray(row);
    if (!parsed) return null;
    rows.push(parsed);
  }
  return rows;
}

function isPermissionRule(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  const action = asString(record.action);
  return (
    Boolean(asString(record.permission)) &&
    Boolean(asString(record.pattern)) &&
    (action === 'allow' || action === 'deny' || action === 'ask')
  );
}

function isFileDiff(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  const hasFile = Boolean(asString(record.file));
  const hasAdditions = asNumber(record.additions) !== undefined;
  const hasDeletions = asNumber(record.deletions) !== undefined;
  if (!hasFile || !hasAdditions || !hasDeletions) return false;
  const hasLegacyContent = typeof record.before === 'string' && typeof record.after === 'string';
  const hasPatchContent = typeof record.patch === 'string';
  return hasLegacyContent || hasPatchContent;
}

export function isSessionInfo(value: unknown): value is SessionInfo {
  const record = asRecord(value);
  if (!record) return false;

  if (
    !asString(record.id) ||
    !asString(record.slug) ||
    !asString(record.projectID) ||
    !asString(record.directory) ||
    asString(record.title) === undefined ||
    !asString(record.version)
  ) {
    return false;
  }

  const time = asRecord(record.time);
  if (!time || asNumber(time.created) === undefined || asNumber(time.updated) === undefined) {
    return false;
  }
  if (time.compacting !== undefined && asNumber(time.compacting) === undefined) return false;
  if (time.archived !== undefined && asNumber(time.archived) === undefined) return false;
  if (time.pinned !== undefined && asNumber(time.pinned) === undefined) return false;

  if (record.parentID !== undefined && asString(record.parentID) === undefined) return false;

  if (record.summary !== undefined) {
    const summary = asRecord(record.summary);
    if (!summary) return false;
    if (
      asNumber(summary.additions) === undefined ||
      asNumber(summary.deletions) === undefined ||
      asNumber(summary.files) === undefined
    ) {
      return false;
    }
    if (summary.diffs !== undefined) {
      if (!Array.isArray(summary.diffs)) return false;
      if (!summary.diffs.every((diff) => isFileDiff(diff))) return false;
    }
  }

  if (record.share !== undefined) {
    const share = asRecord(record.share);
    if (!share || !asString(share.url)) return false;
  }

  if (record.permission !== undefined) {
    if (!Array.isArray(record.permission)) return false;
    if (!record.permission.every((entry) => isPermissionRule(entry))) return false;
  }

  if (record.revert !== undefined) {
    const revert = asRecord(record.revert);
    if (!revert || !asString(revert.messageID)) return false;
    if (revert.partID !== undefined && asString(revert.partID) === undefined) return false;
    if (revert.snapshot !== undefined && asString(revert.snapshot) === undefined) return false;
    if (revert.diff !== undefined && asString(revert.diff) === undefined) return false;
  }

  return true;
}

function isSessionEventProperties(value: unknown): value is WorkerStateEventMap['session.created'] {
  const record = asRecord(value);
  if (!record) return false;
  return isSessionInfo(record.info);
}

function isSessionStatusInfo(value: unknown): value is SessionStatusInfo {
  const record = asRecord(value);
  if (!record) return false;
  const type = asString(record.type);
  if (type === 'idle' || type === 'busy') return true;
  if (type !== 'retry') return false;
  return (
    asNumber(record.attempt) !== undefined &&
    asString(record.message) !== undefined &&
    asNumber(record.next) !== undefined
  );
}

function isSessionStatusProperties(value: unknown): value is WorkerStateEventMap['session.status'] {
  const record = asRecord(value);
  if (!record) return false;
  return asString(record.sessionID) !== undefined && isSessionStatusInfo(record.status);
}

export function isProjectInfo(value: unknown): value is ProjectInfo {
  const record = asRecord(value);
  if (!record) return false;

  if (!asString(record.id) || !asString(record.worktree)) return false;
  if (record.vcs !== undefined && record.vcs !== 'git') return false;
  if (record.name !== undefined && typeof record.name !== 'string') return false;

  const time = asRecord(record.time);
  if (!time || asNumber(time.created) === undefined || asNumber(time.updated) === undefined) {
    return false;
  }
  if (time.initialized !== undefined && asNumber(time.initialized) === undefined) return false;

  const sandboxes = asStringArray(record.sandboxes);
  if (!sandboxes) return false;

  if (record.icon !== undefined) {
    const icon = asRecord(record.icon);
    if (!icon) return false;
    if (icon.url !== undefined && typeof icon.url !== 'string') return false;
    if (icon.override !== undefined && typeof icon.override !== 'string') return false;
    if (icon.color !== undefined && typeof icon.color !== 'string') return false;
  }

  if (record.commands !== undefined) {
    const commands = asRecord(record.commands);
    if (!commands) return false;
    if (commands.start !== undefined && typeof commands.start !== 'string') return false;
  }

  return true;
}

function isVcsBranchUpdatedProperties(
  value: unknown,
): value is WorkerStateEventMap['vcs.branch.updated'] {
  const record = asRecord(value);
  if (!record) return false;
  return record.branch === undefined || asString(record.branch) !== undefined;
}

function isPermissionAskedProperties(
  value: unknown,
): value is WorkerStateEventMap['permission.asked'] {
  const record = asRecord(value);
  if (!record) return false;

  if (
    !asString(record.id) ||
    !asString(record.sessionID) ||
    !asString(record.permission) ||
    !asStringArray(record.patterns) ||
    !asRecord(record.metadata) ||
    !asStringArray(record.always)
  ) {
    return false;
  }

  if (record.tool !== undefined) {
    const tool = asRecord(record.tool);
    if (!tool) return false;
    if (!asString(tool.messageID) || !asString(tool.callID)) return false;
  }

  return true;
}

function isQuestionOption(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  return Boolean(asString(record.label) && asString(record.description));
}

function isQuestionInfo(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;

  if (!asString(record.question) || !asString(record.header)) return false;
  if (!Array.isArray(record.options) || !record.options.every((option) => isQuestionOption(option))) {
    return false;
  }

  if (record.multiple !== undefined && asBoolean(record.multiple) === undefined) return false;
  if (record.custom !== undefined && asBoolean(record.custom) === undefined) return false;
  return true;
}

function isQuestionAskedProperties(value: unknown): value is WorkerStateEventMap['question.asked'] {
  const record = asRecord(value);
  if (!record) return false;
  if (!asString(record.id) || !asString(record.sessionID)) return false;
  if (
    !Array.isArray(record.questions) ||
    !record.questions.every((question) => isQuestionInfo(question))
  ) {
    return false;
  }

  if (record.tool !== undefined) {
    const tool = asRecord(record.tool);
    if (!tool) return false;
    if (!asString(tool.messageID) || !asString(tool.callID)) return false;
  }
  return true;
}

function isPermissionRepliedProperties(
  value: unknown,
): value is WorkerStateEventMap['permission.replied'] {
  const record = asRecord(value);
  if (!record) return false;
  const reply = asString(record.reply);
  return (
    asString(record.sessionID) !== undefined &&
    asString(record.requestID) !== undefined &&
    (reply === 'once' || reply === 'always' || reply === 'reject')
  );
}

function isQuestionRepliedProperties(
  value: unknown,
): value is WorkerStateEventMap['question.replied'] {
  const record = asRecord(value);
  if (!record) return false;
  return (
    asString(record.sessionID) !== undefined &&
    asString(record.requestID) !== undefined &&
    asStringMatrix(record.answers) !== null
  );
}

function isQuestionRejectedProperties(
  value: unknown,
): value is WorkerStateEventMap['question.rejected'] {
  const record = asRecord(value);
  if (!record) return false;
  return asString(record.sessionID) !== undefined && asString(record.requestID) !== undefined;
}

function isWorktreeReadyProperties(value: unknown): value is WorkerStateEventMap['worktree.ready'] {
  const record = asRecord(value);
  if (!record) return false;
  return asString(record.name) !== undefined && asString(record.branch) !== undefined;
}

const WORKER_STATE_EVENT_TYPES = [
  'session.created',
  'session.updated',
  'session.deleted',
  'session.status',
  'project.updated',
  'vcs.branch.updated',
  'permission.asked',
  'question.asked',
  'permission.replied',
  'question.replied',
  'question.rejected',
  'worktree.ready',
] as const satisfies readonly WorkerStateEventType[];

const WORKER_STATE_EVENT_TYPE_SET = new Set<string>(WORKER_STATE_EVENT_TYPES);

function isWorkerStateEventType(value: string): value is WorkerStateEventType {
  return WORKER_STATE_EVENT_TYPE_SET.has(value);
}

export function parseWorkerStatePacket(packet: SsePacket): WorkerStatePacket | null {
  const packetType = packet.payload.type;
  if (!isWorkerStateEventType(packetType)) return null;

  const properties = packet.payload.properties;
  switch (packetType) {
    case 'session.created':
      if (!isSessionEventProperties(properties)) return null;
      return { directory: packet.directory, payload: { type: 'session.created', properties } };
    case 'session.updated':
      if (!isSessionEventProperties(properties)) return null;
      return { directory: packet.directory, payload: { type: 'session.updated', properties } };
    case 'session.deleted':
      if (!isSessionEventProperties(properties)) return null;
      return { directory: packet.directory, payload: { type: 'session.deleted', properties } };
    case 'session.status':
      if (!isSessionStatusProperties(properties)) return null;
      return { directory: packet.directory, payload: { type: 'session.status', properties } };
    case 'project.updated':
      if (!isProjectInfo(properties)) return null;
      return { directory: packet.directory, payload: { type: 'project.updated', properties } };
    case 'vcs.branch.updated':
      if (!isVcsBranchUpdatedProperties(properties)) return null;
      return { directory: packet.directory, payload: { type: 'vcs.branch.updated', properties } };
    case 'permission.asked':
      if (!isPermissionAskedProperties(properties)) return null;
      return { directory: packet.directory, payload: { type: 'permission.asked', properties } };
    case 'question.asked':
      if (!isQuestionAskedProperties(properties)) return null;
      return { directory: packet.directory, payload: { type: 'question.asked', properties } };
    case 'permission.replied':
      if (!isPermissionRepliedProperties(properties)) return null;
      return { directory: packet.directory, payload: { type: 'permission.replied', properties } };
    case 'question.replied':
      if (!isQuestionRepliedProperties(properties)) return null;
      return { directory: packet.directory, payload: { type: 'question.replied', properties } };
    case 'question.rejected':
      if (!isQuestionRejectedProperties(properties)) return null;
      return { directory: packet.directory, payload: { type: 'question.rejected', properties } };
    case 'worktree.ready':
      if (!isWorktreeReadyProperties(properties)) return null;
      return { directory: packet.directory, payload: { type: 'worktree.ready', properties } };
  }
}
