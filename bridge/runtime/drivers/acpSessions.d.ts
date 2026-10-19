import type { SessionRef, SessionKey } from '../../../shared/runtime/identity.js';
import type { JsonValue } from '../../../shared/runtime/capabilities.js';
import type { AcpObject, AcpRpc } from './acpRpc.js';
import type { AcpCapabilities, AcpQueue } from '../../../shared/runtime/native/acp/capabilities.js';
import type { AcpMutations, AcpMutationResult } from './acpMutations.js';
export interface AcpSession {
  readonly session: SessionRef;
  readonly key: SessionKey;
  readonly native: AcpObject;
}
export type AcpCreatedSession = AcpMutationResult<JsonValue> & Partial<AcpSession>;
export interface AcpSessions {
  create(input: { readonly idempotencyKey: string }): Promise<AcpCreatedSession>;
  load(
    input: { readonly idempotencyKey: string; readonly session: SessionRef },
    method?: 'session/load' | 'session/resume',
  ): Promise<AcpCreatedSession>;
  list(input?: { readonly cursor?: string }): Promise<{
    readonly items: readonly AcpSession[];
    readonly status: 'partial' | 'complete' | 'unsupported';
    readonly cursor: string | null;
    readonly reason?: string;
  }>;
  update(params: JsonValue): void;
  sessionFor(nativeSessionId: string): SessionRef;
  requireSession(session: SessionRef): SessionRef;
  register(result: AcpObject): AcpSession;
  forget(session: SessionRef): void;
  get(
    session: SessionRef,
  ):
    | AcpSession
    | { readonly session: SessionRef; readonly status: 'partial'; readonly reason: 'not_loaded' };
  history(input: { readonly session: SessionRef; readonly after?: number }): {
    readonly items: readonly { readonly seq: number; readonly update: AcpObject }[];
    readonly status: 'partial';
    readonly reason: string;
    readonly floor: number;
    readonly through: number;
  };
}
export function createAcpSessions(options: {
  readonly rpc: AcpRpc;
  readonly mutations: AcpMutations;
  readonly capabilities: AcpCapabilities;
  readonly queue: AcpQueue;
  readonly cwd: string;
  readonly emit: (event: AcpObject) => void;
}): AcpSessions;
