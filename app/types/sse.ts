// ---------------------------------------------------------------------------
// SSE Packet Type Definitions
// ---------------------------------------------------------------------------
// Canonical type definitions for all SSE events sent by the OpenCode server.
// Derived from Zod schemas in opencode/packages/opencode/src/.
// ---------------------------------------------------------------------------

// ── SSE envelope ──────────────────────────────────────────────────────────

/** Outer structure of every SSE data frame from the server. */
export type SsePacket = {
  directory: string;
  payload: {
    type: string;
    properties: Record<string, unknown>;
  };
};

// ── Shared / Nested Types ─────────────────────────────────────────────────

/** Serialised error object (discriminated union on the server, flattened here). */
export type MessageError = {
  name: string;
  data?: Record<string, unknown>;
};

/** ToolState discriminated union (status). */
export type ToolStatePending = {
  status: 'pending';
  input: Record<string, unknown>;
  raw: string;
};

export type ToolStateRunning = {
  status: 'running';
  input: Record<string, unknown>;
  title?: string;
  metadata?: Record<string, unknown>;
  time: { start: number };
};

export type ToolStateCompleted = {
  status: 'completed';
  input: Record<string, unknown>;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { start: number; end: number; compacted?: number };
  attachments?: FilePart[];
};

export type ToolStateError = {
  status: 'error';
  input: Record<string, unknown>;
  error: string;
  metadata?: Record<string, unknown>;
  time: { start: number; end: number };
};

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

/** FilePartSource discriminated union (type). */
export type FileSourceText = {
  value: string;
  start: number;
  end: number;
};

export type FileSource = {
  type: 'file';
  path: string;
  text: FileSourceText;
};

export type SymbolSource = {
  type: 'symbol';
  path: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  name: string;
  kind: number;
  text: FileSourceText;
};

export type ResourceSource = {
  type: 'resource';
  clientName: string;
  uri: string;
  text: FileSourceText;
};

export type FilePartSource = FileSource | SymbolSource | ResourceSource;

/** Snapshot.FileDiff */
export type FileDiff = {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
  status?: 'added' | 'deleted' | 'modified';
};

/** Session.Info */
export type SessionInfo = {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  parentID?: string;
  summary?: {
    additions: number;
    deletions: number;
    files: number;
    diffs?: FileDiff[];
  };
  share?: { url: string };
  title: string;
  version: string;
  time: {
    created: number;
    updated: number;
    compacting?: number;
    archived?: number;
    pinned?: number;
  };
  permission?: PermissionRule[];
  revert?: {
    messageID: string;
    partID?: string;
    snapshot?: string;
    diff?: string;
  };
};

/** PermissionNext.Rule */
export type PermissionRule = {
  permission: string;
  pattern: string;
  action: 'allow' | 'deny' | 'ask';
};

/** PermissionNext.Request */
export type PermissionNextRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: {
    messageID: string;
    callID: string;
  };
};

/** Question.Option */
export type QuestionOption = {
  label: string;
  description: string;
};

/** Question.Info */
export type QuestionInfo = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
};

/** Question.Request */
export type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: {
    messageID: string;
    callID: string;
  };
};

/** SessionStatus.Info discriminated union (type). */
export type SessionStatusInfo =
  | { type: 'idle' }
  | { type: 'busy' }
  | { type: 'retry'; attempt: number; message: string; next: number };

/** Todo.Info */
export type TodoInfo = {
  content: string;
  status: string;
  priority: string;
  id: string;
};

/** Pty.Info */
export type PtyInfo = {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: 'running' | 'exited';
  pid: number;
};

/** Project.Info */
export type ProjectInfo = {
  id: string;
  worktree: string;
  vcs?: 'git';
  name?: string;
  icon?: {
    url?: string;
    override?: string;
    color?: string;
  };
  commands?: {
    start?: string;
  };
  time: {
    created: number;
    updated: number;
    initialized?: number;
  };
  sandboxes: string[];
};

// ── MessageV2 types ───────────────────────────────────────────────────────

/** OutputFormat discriminated union. */
export type OutputFormatText = { type: 'text' };
export type OutputFormatJsonSchema = {
  type: 'json_schema';
  schema: Record<string, unknown>;
  retryCount: number;
};
export type OutputFormat = OutputFormatText | OutputFormatJsonSchema;

/** APIError shape (used in RetryPart.error and MessageError). */
export type APIErrorData = {
  name: 'APIError';
  data: {
    message: string;
    statusCode?: number;
    isRetryable: boolean;
    responseHeaders?: Record<string, string>;
    responseBody?: string;
    metadata?: Record<string, string>;
  };
};

/** UserMessageInfo — role: 'user' */
export type UserMessageInfo = {
  id: string;
  sessionID: string;
  role: 'user';
  time: { created: number };
  format?: OutputFormat;
  summary?: {
    title?: string;
    body?: string;
    diffs: FileDiff[];
  };
  agent: string;
  model: { providerID: string; modelID: string };
  system?: string;
  tools?: Record<string, boolean>;
  variant?: string;
};

/** AssistantMessageInfo — role: 'assistant' */
export type AssistantMessageInfo = {
  id: string;
  sessionID: string;
  role: 'assistant';
  time: { created: number; completed?: number };
  error?: MessageError;
  parentID: string;
  modelID: string;
  providerID: string;
  /** @deprecated */
  mode: string;
  agent: string;
  path: { cwd: string; root: string };
  summary?: boolean;
  cost: number;
  tokens: {
    total?: number;
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  structured?: unknown;
  variant?: string;
  finish?: string;
};

/** MessageInfo = User | Assistant (discriminated on `role`). */
export type MessageInfo = UserMessageInfo | AssistantMessageInfo;

// ── Part types (12 subtypes, discriminated on `type`) ─────────────────────

type PartBase = {
  id: string;
  sessionID: string;
  messageID: string;
};

export type TextPart = PartBase & {
  type: 'text';
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start: number; end?: number };
  metadata?: Record<string, unknown>;
};

export type ReasoningPart = PartBase & {
  type: 'reasoning';
  text: string;
  metadata?: Record<string, unknown>;
  time: { start: number; end?: number };
};

export type ToolPart = PartBase & {
  type: 'tool';
  callID: string;
  tool: string;
  state: ToolState;
  metadata?: Record<string, unknown>;
};

export type FilePart = PartBase & {
  type: 'file';
  mime: string;
  filename?: string;
  url: string;
  source?: FilePartSource;
};

export type PatchPart = PartBase & {
  type: 'patch';
  hash: string;
  files: string[];
};

export type SnapshotPart = PartBase & {
  type: 'snapshot';
  snapshot: string;
};

export type SubtaskPart = PartBase & {
  type: 'subtask';
  prompt: string;
  description: string;
  agent: string;
  model?: { providerID: string; modelID: string };
  command?: string;
};

export type AgentPart = PartBase & {
  type: 'agent';
  name: string;
  source?: { value: string; start: number; end: number };
};

export type CompactionPart = PartBase & {
  type: 'compaction';
  auto: boolean;
};

export type RetryPart = PartBase & {
  type: 'retry';
  attempt: number;
  error: APIErrorData;
  time: { created: number };
};

export type StepStartPart = PartBase & {
  type: 'step-start';
  snapshot?: string;
};

export type StepFinishPart = PartBase & {
  type: 'step-finish';
  reason: string;
  snapshot?: string;
  cost: number;
  tokens: {
    total?: number;
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
};

/** MessagePart — discriminated union of all 12 part subtypes. */
export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolPart
  | FilePart
  | PatchPart
  | SnapshotPart
  | SubtaskPart
  | AgentPart
  | CompactionPart
  | RetryPart
  | StepStartPart
  | StepFinishPart;

// ── Packet types (one per SSE event) ──────────────────────────────────────

// message events
export type MessageUpdatedPacket = { info: MessageInfo };
export type MessageRemovedPacket = { sessionID: string; messageID: string };
export type MessagePartUpdatedPacket = { part: MessagePart; delta?: string };
export type MessagePartDeltaPacket = {
  sessionID: string;
  messageID: string;
  partID: string;
  field: string;
  delta: string;
};
export type MessagePartRemovedPacket = { sessionID: string; messageID: string; partID: string };

// session events
export type SessionUpdatedPacket = { info: SessionInfo };
export type SessionDeletedPacket = { info: SessionInfo };
export type SessionCreatedPacket = { info: SessionInfo };
export type SessionDiffPacket = { sessionID: string; diff: FileDiff[] };
export type SessionErrorPacket = { sessionID?: string; error?: MessageError };
export type SessionStatusPacket = { sessionID: string; status: SessionStatusInfo };
export type SessionCompactedPacket = { sessionID: string };

// permission events
export type PermissionAskedPacket = PermissionNextRequest;
export type PermissionRepliedPacket = {
  sessionID: string;
  requestID: string;
  reply: 'once' | 'always' | 'reject';
};

// question events
export type QuestionAskedPacket = QuestionRequest;
export type QuestionRepliedPacket = { sessionID: string; requestID: string; answers: string[][] };
export type QuestionRejectedPacket = { sessionID: string; requestID: string };

// todo events
export type TodoUpdatedPacket = { sessionID: string; todos: TodoInfo[] };

// pty events
export type PtyCreatedPacket = { info: PtyInfo };
export type PtyUpdatedPacket = { info: PtyInfo };
export type PtyExitedPacket = { id: string; exitCode: number };
export type PtyDeletedPacket = { id: string };

// worktree events
export type WorktreeReadyPacket = { name: string; branch: string };
export type WorktreeFailedPacket = { message: string };

// project events
export type ProjectUpdatedPacket = ProjectInfo;

// other events
export type VcsBranchUpdatedPacket = { branch?: string };
export type FileEditedPacket = { file: string };
export type FileWatcherUpdatedPacket = { file: string; event: 'add' | 'change' | 'unlink' };
export type LspUpdatedPacket = Record<string, never>;
export type LspDiagnosticsPacket = { serverID: string; path: string };
export type CommandExecutedPacket = {
  name: string;
  sessionID: string;
  arguments: string;
  messageID: string;
};
export type InstallationUpdatedPacket = { version: string };
export type InstallationUpdateAvailablePacket = { version: string };
export type McpToolsChangedPacket = { server: string };

// connection lifecycle (client-side only)
export type ConnectionOpenPacket = Record<string, never>;
export type ConnectionErrorPacket = { message: string; statusCode?: number };
export type ConnectionReconnectedPacket = Record<string, never>;

// ── GlobalEventMap ────────────────────────────────────────────────────────

/** Maps every SSE event name to its strongly-typed payload. */
export type GlobalEventMap = {
  'message.updated': MessageUpdatedPacket;
  'message.removed': MessageRemovedPacket;
  'message.part.updated': MessagePartUpdatedPacket;
  'message.part.delta': MessagePartDeltaPacket;
  'message.part.removed': MessagePartRemovedPacket;
  'session.created': SessionCreatedPacket;
  'session.updated': SessionUpdatedPacket;
  'session.deleted': SessionDeletedPacket;
  'session.diff': SessionDiffPacket;
  'session.error': SessionErrorPacket;
  'session.status': SessionStatusPacket;
  'session.compacted': SessionCompactedPacket;
  'permission.asked': PermissionAskedPacket;
  'permission.replied': PermissionRepliedPacket;
  'question.asked': QuestionAskedPacket;
  'question.replied': QuestionRepliedPacket;
  'question.rejected': QuestionRejectedPacket;
  'todo.updated': TodoUpdatedPacket;
  'pty.created': PtyCreatedPacket;
  'pty.updated': PtyUpdatedPacket;
  'pty.exited': PtyExitedPacket;
  'pty.deleted': PtyDeletedPacket;
  'worktree.ready': WorktreeReadyPacket;
  'worktree.failed': WorktreeFailedPacket;
  'project.updated': ProjectUpdatedPacket;
  'vcs.branch.updated': VcsBranchUpdatedPacket;
  'file.edited': FileEditedPacket;
  'file.watcher.updated': FileWatcherUpdatedPacket;
  'lsp.updated': LspUpdatedPacket;
  'lsp.client.diagnostics': LspDiagnosticsPacket;
  'command.executed': CommandExecutedPacket;
  'installation.updated': InstallationUpdatedPacket;
  'installation.update-available': InstallationUpdateAvailablePacket;
  'mcp.tools.changed': McpToolsChangedPacket;
  // connection lifecycle
  'connection.open': ConnectionOpenPacket;
  'connection.error': ConnectionErrorPacket;
  'connection.reconnected': ConnectionReconnectedPacket;
};

type SsePacketByType<K extends keyof GlobalEventMap> = {
  directory: string;
  payload: {
    type: K;
    properties: GlobalEventMap[K];
  };
};

export type KnownSsePacket = {
  [K in keyof GlobalEventMap]: SsePacketByType<K>;
}[keyof GlobalEventMap];

export type WorkerStateEventMap = Pick<
  GlobalEventMap,
  | 'session.created'
  | 'session.updated'
  | 'session.deleted'
  | 'session.status'
  | 'project.updated'
  | 'vcs.branch.updated'
  | 'permission.asked'
  | 'question.asked'
  | 'permission.replied'
  | 'question.replied'
  | 'question.rejected'
  | 'worktree.ready'
>;

export type WorkerStateEventType = keyof WorkerStateEventMap;

export type WorkerStatePacket = {
  [K in WorkerStateEventType]: SsePacketByType<K>;
}[WorkerStateEventType];
