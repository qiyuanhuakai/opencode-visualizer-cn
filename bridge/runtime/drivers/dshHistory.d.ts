import type { SessionRef } from '../../../shared/runtime/identity.js';
import type { FollowState, HistoryPage } from '../../../shared/runtime/native/dsh/follow.js';
import type { DshTransport } from './dshTransport.js';
export function readDshHistoryPage(options: { readonly transport: DshTransport; readonly session: SessionRef; readonly state: FollowState; readonly beforeSeq?: number; readonly throughSeq?: number; readonly limit?: number }): Promise<HistoryPage & { readonly session: SessionRef; readonly throughSeq: number; readonly generation: number; readonly revision: number }>;
