export type BackendKind = 'opencode' | 'codex';

export type BackendCapabilities = {
  projects: boolean;
  worktrees: boolean;
  sessions: boolean;
  sessionFork: boolean;
  sessionRevert: boolean;
};

export type ListSessionsOptions = {
  directory?: string;
  instanceDirectory?: string;
  roots?: boolean;
  search?: string;
  limit?: number;
};

export type SessionUpdatePayload = {
  title?: string;
  time?: {
    archived?: number;
    pinned?: number;
  };
};

export type ProjectUpdatePayload = {
  directory?: string;
  name?: string;
  icon?: {
    url?: string;
    override?: string;
    color?: string;
  };
  commands?: {
    start?: string;
  };
};

export type BackendAdapter = {
  kind: BackendKind;
  label: string;
  capabilities: BackendCapabilities;
  createSession(directory?: string): Promise<unknown>;
  forkSession(sessionId: string, messageId: string, directory?: string): Promise<unknown>;
  updateSession(
    sessionId: string,
    payload: SessionUpdatePayload,
    directory?: string,
  ): Promise<unknown>;
  deleteSession(sessionId: string, directory?: string): Promise<unknown>;
  revertSession(sessionId: string, messageId: string, directory?: string): Promise<unknown>;
  unrevertSession(sessionId: string, directory?: string): Promise<unknown>;
  listSessions(options?: ListSessionsOptions): Promise<unknown>;
  updateProject(projectId: string, payload: ProjectUpdatePayload): Promise<unknown>;
  createWorktree(directory: string): Promise<unknown>;
  deleteWorktree(directory: string, targetDirectory: string): Promise<unknown>;
};
