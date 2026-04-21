import type { BridgeErrorData, SessionInfo } from '../contracts/models';

export type SessionStore = {
  list(query?: { directory?: string; providerID?: string; status?: string }): Promise<SessionInfo[]>;
  get(sessionID: string): Promise<SessionInfo | null>;
  put(session: SessionInfo): Promise<void>;
  delete(sessionID: string): Promise<boolean>;
};

export type SessionStatePatch = Partial<Omit<SessionInfo, 'id' | 'createdAt'>> & {
  lastError?: BridgeErrorData;
};

export type SessionManagerPort = {
  create(session: SessionInfo): Promise<void>;
  update(sessionID: string, patch: SessionStatePatch): Promise<SessionInfo>;
  get(sessionID: string): Promise<SessionInfo | null>;
  delete(sessionID: string): Promise<boolean>;
};
