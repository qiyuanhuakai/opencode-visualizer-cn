export type TimelineEntryKind = 'message' | 'tool' | 'thinking' | 'interaction' | 'usage';
export type TerminalReason = 'completed' | 'failed' | 'cancelled' | 'timeout' | 'aborted';
export type TurnCommandPhase = 'accepted' | 'sent' | 'cancelled';

export interface HostTimelineSource {
  readonly kind: 'host';
  readonly commandId: string;
}
export interface NativeTimelineSource {
  readonly kind: 'native';
  readonly harness: string;
  readonly nativeEventId: string;
}
export type TimelineSource = HostTimelineSource | NativeTimelineSource;

export interface OpenTurnInput {
  readonly turnId?: string;
  readonly causedBy?: string | null;
  readonly parentTurn?: string | null;
  readonly attempt?: number;
  readonly sourceNativeId?: string | null;
}

export interface TurnView {
  readonly turnId: string;
  readonly causedBy: string | null;
  readonly parentTurn: string | null;
  readonly attempt: number;
  readonly sourceNativeId: string | null;
  readonly createdAt: number;
  readonly accepted: boolean;
  readonly acceptedAt: number | null;
  readonly acceptedBy: string | null;
  readonly sent: boolean;
  readonly sentAt: number | null;
  readonly sentBy: string | null;
  readonly observed: boolean;
  readonly observedAt: number | null;
  readonly observedBy: string | null;
  readonly terminal: boolean;
  readonly terminalAt: number | null;
  readonly terminalReason: TerminalReason | null;
  readonly terminalBy: string | null;
  readonly entryCount: number;
  readonly lastOrder: number | null;
  readonly seqMax: number;
}

export interface TimelineEntryView {
  readonly entryId: string;
  readonly order: number;
  readonly seq: number;
  readonly turnId: string;
  readonly kind: TimelineEntryKind;
  readonly source: TimelineSource;
  readonly at: number;
  readonly payload: Record<string, unknown>;
  readonly late: boolean;
  readonly dedupKey: string;
}

export interface TimelinePage {
  readonly entries: readonly TimelineEntryView[];
  readonly nextCursor: number | null;
  readonly total: number;
}

export interface TimelineHistoryGroup {
  readonly source: TimelineSource;
  readonly count: number;
  readonly entries: readonly TimelineEntryView[];
}
export interface TurnHistory {
  readonly turnId: string;
  readonly entryCount: number;
  readonly sources: readonly TimelineHistoryGroup[];
}

export interface TurnCommandOutcome {
  readonly turn: TurnView;
  readonly applied: boolean;
  readonly superseded: boolean;
  readonly duplicate: boolean;
  readonly entry: TimelineEntryView | null;
}
export interface TurnOutcome {
  readonly turn: TurnView;
  readonly applied: boolean;
  readonly superseded: boolean;
  readonly duplicate: boolean;
}
export interface TimelineEntryOutcome {
  readonly entry: TimelineEntryView;
  readonly duplicate: boolean;
}

export interface TurnCommandInput {
  readonly turnId: string;
  readonly commandId: string;
  readonly phase: TurnCommandPhase;
  readonly at?: number;
  readonly payload?: Record<string, unknown>;
}
export interface TurnEventInput {
  readonly turnId: string;
  readonly source: TimelineSource;
  readonly kind: TimelineEntryKind;
  readonly at?: number;
  readonly seq?: number;
  readonly payload: Record<string, unknown>;
}
export interface TurnEndInput {
  readonly turnId: string;
  readonly source: TimelineSource;
  readonly terminalReason: TerminalReason;
  readonly at?: number;
}
export interface TimelinePageInput {
  readonly turnId?: string;
  readonly cursor?: number | null;
  readonly limit?: number;
}

export interface TurnServiceState {
  readonly turns: number;
  readonly entries: number;
  readonly duplicates: number;
  readonly superseded: number;
  readonly late: number;
  readonly closed: boolean;
}

export interface TurnService {
  open(input?: OpenTurnInput): TurnView;
  command(input: TurnCommandInput): TurnCommandOutcome;
  event(input: TurnEventInput): TimelineEntryOutcome;
  end(input: TurnEndInput): TurnOutcome;
  turn(turnId: string): TurnView;
  turns(): readonly TurnView[];
  page(input?: TimelinePageInput): TimelinePage;
  history(turnId: string): TurnHistory;
  gaps(turnId: string): readonly number[];
  close(): void;
  readonly state: TurnServiceState;
}

/**
 * Canonical Turn service (task 32). Turns are projected from two ordered origins — Host commands
 * and native events — into one paged timeline where every entry carries its complete source.
 */
export function createTurnService(): TurnService;
