export type SessionTreeSession = {
  type: 'session';
  sessionId: string;
  projectId: string;
  directory: string;
  title: string;
  status: 'busy' | 'idle' | 'retry' | 'unknown';
  pinnedAt: number;
  isPinned: boolean;
  isImplicitlyPinned: boolean;
};

export type SessionTreeSandbox = {
  type: 'sandbox';
  directory: string;
  projectId: string;
  name: string;
  pinnedAt: number;
  isPinned: boolean;
  isImplicitlyPinned: boolean;
  sessions: SessionTreeSession[];
};

export type SessionTreeProject = {
  type: 'project';
  projectId: string;
  name: string;
  color?: string;
  pinnedAt: number;
  isPinned: boolean;
  sandboxes: SessionTreeSandbox[];
};

export type SessionTreeData = SessionTreeProject[];
