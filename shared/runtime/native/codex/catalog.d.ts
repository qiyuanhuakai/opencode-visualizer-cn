import type { RuntimeStore } from '../../../../bridge/runtime/storage/runtimeStore.js';
import type { SessionRef } from '../../identity.js';
import type { JsonValue } from '../../capabilities.js';
export interface CodexSummary {
  readonly session: SessionRef;
  readonly title: string;
  readonly cwd: string | null;
  readonly archived: boolean;
  readonly modelProvider: string | null;
  readonly createdAt: number | null;
  readonly updatedAt: number | null;
  readonly source: JsonValue;
  readonly agentNickname: string | null;
  readonly agentRole: string | null;
}
export interface CodexCatalog {
  readonly revision: number;
  summary(thread: JsonValue, archived?: boolean): Promise<CodexSummary | null>;
  changed(session: SessionRef, method: string, params?: JsonValue): Promise<void>;
  invalidate(): void;
}
export function createCodexCatalog(options: {
  readonly store: RuntimeStore;
  readonly sessionFor: (id: string) => SessionRef;
  readonly assertCurrent: () => void;
  readonly newId: () => string;
  readonly privacy: (value: unknown) => JsonValue;
}): CodexCatalog;
