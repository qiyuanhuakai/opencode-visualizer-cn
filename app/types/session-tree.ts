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
  key?: string;
  directory: string;
  pinDirectory?: string;
  projectId: string;
  name: string;
  kind?: 'global' | 'sandbox' | 'folder' | 'branch';
  pinnedAt: number;
  isPinned: boolean;
  isImplicitlyPinned: boolean;
  sessions: SessionTreeSession[];
};

export type SessionTreeProject = {
  type: 'project';
  key?: string;
  projectId: string;
  directory?: string;
  pinDirectory?: string;
  kind?: 'global' | 'sandbox';
  name: string;
  color?: string;
  pinnedAt: number;
  isPinned: boolean;
  sandboxes: SessionTreeSandbox[];
};

export type SessionTreeData = SessionTreeProject[];
