import type {
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
import type { KimiWebReconcilePartKind } from './kimiWebMessageReconcile';

export type KimiWebMessageSource = {
  subscribe(sessionIds: string[], cursors?: Record<string, KimiWebWsCursor>): Promise<KimiWebWsAck>;
  subscriptions(): string[];
  onFrame(listener: (frame: KimiWebWsFrame) => void): () => void;
  onResyncRequired(listener: (request: KimiWebWsResyncRequest) => void): () => void;
  onReconnectStart?(listener: () => void): () => void;
  onReconnectReady?(listener: (ack: KimiWebWsAck) => void): () => void;
  onClose(listener: (info: KimiWebWsCloseInfo) => void): () => void;
};

export type KimiWebSyncState =
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'replaying'; readonly boundary: 'matching-subscribe-ack' }
  | { readonly kind: 'degraded'; readonly cursor: KimiWebWsCursor }
  | { readonly kind: 'rebuilding'; readonly buffered: readonly KimiWebWsFrame[]; readonly epoch?: string }
  | { readonly kind: 'live'; readonly cursor: KimiWebWsCursor };

export type KimiWebStepOp = Extract<KimiWebNormalizeOp, { kind: 'step' }>;
export type KimiWebSessionOp = Extract<KimiWebNormalizeOp, { kind: 'session' }>;
export type KimiWebFrameOrigin = 'live' | 'durable-replay' | 'snapshot-rebuild';

export type KimiWebFrameContext = {
  readonly epoch?: string;
  readonly sequence?: number;
  readonly origin: KimiWebFrameOrigin;
};

export type KimiWebSessionModePatch = {
  readonly permission?: string;
  readonly planMode?: boolean;
  readonly swarmMode?: boolean;
  readonly towerMode?: boolean;
};

export type KimiWebBridgeSessionState = {
  readonly sessionId: string;
  readonly sync: KimiWebSyncState;
  readonly usage?: KimiWebUsageReport;
  readonly contextTokens?: number;
  readonly maxContextTokens?: number;
  readonly permission?: string;
  readonly planMode?: boolean;
  readonly swarmMode?: boolean;
  readonly towerMode?: boolean;
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
  readonly restClient: Pick<KimiWebClient, 'getSnapshot' | 'getMessages'>;
  readonly msg: {
    updateMessage(info: MessageInfo): void;
    updatePart(part: MessagePart): void;
    loadHistory(entries: unknown[]): void;
    removeMessage(messageId: string): void;
  };
  readonly applySnapshot: (snapshot: KimiWebSnapshot) => void | Promise<void>;
  readonly onSessionEvent?: (event: KimiWebSessionOp) => void;
  readonly onSessionModeChange?: (
    sessionId: string,
    patch: KimiWebSessionModePatch,
    context: KimiWebFrameContext,
  ) => void;
  readonly onToolPart?: (part: MessagePart) => void;
  readonly onLiveReasoning?: (info: MessageInfo, part: MessagePart) => void;
  readonly onLiveSubagent?: (info: MessageInfo, part: MessagePart) => void;
  /** Todo 16 seam: terminal replay/rebuild parts may close existing UI only; never open a new window. */
  readonly onReconcilePart?: (
    info: MessageInfo,
    part: MessagePart,
    kind: KimiWebReconcilePartKind,
  ) => void;
  readonly onSyncStateChange?: (sessionId: string, state: KimiWebSyncState) => void;
  readonly maxBufferedFrames?: number;
};

export type KimiWebSessionPatch = Partial<KimiWebBridgeSessionState>;
