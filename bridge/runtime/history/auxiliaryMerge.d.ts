export type AuxiliaryPartTime = Readonly<{ start?: number; end?: number; completed?: number }>;
export type AuxiliaryToolState = Readonly<{ status?: string; input?: unknown; output?: unknown; title?: string; time?: AuxiliaryPartTime }>;
export type AuxiliaryPart = Readonly<Record<string, unknown>> & Readonly<{
  readonly id: string;
  readonly type?: string;
  readonly text?: string;
  readonly callID?: string;
  readonly tool?: string;
  readonly time?: AuxiliaryPartTime;
  readonly state?: AuxiliaryToolState;
}>;
export type AuxiliaryEntry = Readonly<{
  readonly info: Readonly<Record<string, unknown>> & Readonly<{ id: string }>;
  readonly parts: readonly AuxiliaryPart[];
}>;
export declare const AUXILIARY_TERMINAL_TOOL_STATUSES: readonly string[];
export declare function isTerminalToolPart(part: unknown): boolean;
export declare function isTerminalTextPart(part: unknown): boolean;
export declare function assertAuxiliaryEntry(entry: unknown): AuxiliaryEntry;
export declare function mergeAuxiliaryPart(existing: AuxiliaryPart | undefined, incoming: AuxiliaryPart): AuxiliaryPart;
export declare function mergeAuxiliaryCanonical(canonical: readonly AuxiliaryEntry[], incoming: readonly AuxiliaryEntry[]): readonly AuxiliaryEntry[];
