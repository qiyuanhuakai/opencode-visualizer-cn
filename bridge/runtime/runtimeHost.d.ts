import type { Hello } from '../../shared/runtime/protocol.js';
import type { JsonValue } from '../../shared/runtime/capabilities.js';
export interface RuntimeSource {
  readonly id: string;
  readonly ownership?: 'owned' | 'borrowed';
  readonly start: (context: { readonly signal: AbortSignal }) => unknown | Promise<unknown>;
  readonly stop: () => unknown | Promise<unknown>;
}
export interface RuntimeInspection {
  readonly role: 'local' | 'manager' | 'execution';
  readonly state: string;
  readonly subscribers: number;
  readonly topology: readonly JsonValue[];
  readonly sources: readonly { readonly id: string; readonly state: string }[];
}
export interface RuntimeConnection {
  readonly generation: number;
  assertCurrent(): void;
  disconnect(): void;
  hello(): Hello;
  inspect(): RuntimeInspection;
}
export interface RuntimeHost {
  start(): void;
  closeAdmission(): void;
  stop(): Promise<void>;
  connect(id: string): RuntimeConnection;
  inspect(): RuntimeInspection;
  mutate<T>(operation: () => Promise<T>): Promise<T>;
  readonly sourcesReady: Promise<void>;
  readonly startupFailures: readonly unknown[];
  readonly resources: {
    register(id: string, ownership: 'owned' | 'borrowed', release: () => Promise<unknown>): void;
    release(): Promise<void>;
  };
}
export function createRuntimeHost(options: {
  readonly environmentId: string;
  readonly role: RuntimeInspection['role'];
  readonly sources?: readonly RuntimeSource[];
  readonly cachedTopology?: readonly JsonValue[];
}): RuntimeHost;
