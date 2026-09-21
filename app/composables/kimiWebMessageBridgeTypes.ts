import type {
  KimiWebAgentStatus,
  KimiWebNormalizeOp,
  KimiWebTurnError,
  KimiWebUsageReport,
} from '../backends/kimiWeb/normalize';
import type { KimiWebClient, KimiWebSnapshot } from '../utils/kimiWeb';
import type {
  KimiWebWsAck,
  KimiWebWsCloseInfo,
  KimiWebWsCursor,
  KimiWebWsFrame,
  KimiWebWsResyncRequest,
} from '../utils/kimiWebWs';
import type { MessageInfo, MessagePart } from '../types/sse';

export type KimiWebMessageSource = {
  subscribe(sessionIds: string[], cursors?: Record<string, KimiWebWsCursor>): Promise<KimiWebWsAck>;
  subscriptions(): string[];
  onFrame(listener: (frame: KimiWebWsFrame) => void): () => void;
  onResyncRequired(listener: (request: KimiWebWsResyncRequest) => void): () => void;
  onClose(listener: (info: KimiWebWsCloseInfo) => void): () => void;
};

export type KimiWebSyncState =
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'replaying'; readonly boundary: 'matching-subscribe-ack' }
  | { readonly kind: 'rebuilding'; readonly buffered: readonly KimiWebWsFrame[] }
  | { readonly kind: 'live'; readonly cursor: KimiWebWsCursor };

export type KimiWebStepOp = Extract<KimiWebNormalizeOp, { kind: 'step' }>;
export type KimiWebSessionOp = Extract<KimiWebNormalizeOp, { kind: 'session' }>;

export type KimiWebBridgeSessionState = {
  readonly sessionId: string;
  readonly sync: KimiWebSyncState;
  readonly usage?: KimiWebUsageReport;
  readonly contextTokens?: number;
  readonly maxContextTokens?: number;
  readonly planMode?: boolean;
  readonly busy?: boolean;
  readonly mainTurnActive?: boolean;
  readonly pendingInteraction?: string;
  readonly lastTurnReason?: string;
  readonly status?: string;
  readonly currentPromptId?: string;
  readonly step?: KimiWebStepOp;
  readonly completion?: {
    readonly reason: 'completed' | 'cancelled' | 'failed';
    readonly error?: KimiWebTurnError;
  };
};

export type KimiWebMessageBridgeOptions = {
  readonly client: KimiWebMessageSource;
  readonly restClient: Pick<KimiWebClient, 'getSnapshot'>;
  readonly msg: {
    updateMessage(info: MessageInfo): void;
    updatePart(part: MessagePart): void;
    loadHistory(entries: unknown[]): void;
  };
  readonly applySnapshot: (snapshot: KimiWebSnapshot) => void | Promise<void>;
  readonly onSessionEvent?: (event: KimiWebSessionOp) => void;
  readonly onToolPart?: (part: MessagePart) => void;
  readonly onLiveReasoning?: (info: MessageInfo, part: MessagePart) => void;
  readonly onLiveSubagent?: (info: MessageInfo, part: MessagePart) => void;
};

export type KimiWebSessionPatch = Partial<KimiWebBridgeSessionState>;
export type KimiWebStatus = KimiWebAgentStatus | undefined;
