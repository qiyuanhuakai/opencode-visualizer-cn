import type { HarnessRegistration, HarnessScope } from '../../../shared/runtime/harnessContract.js';
import type { RuntimeStore } from '../storage/runtimeStore.js';
import type { AdmissionQueue } from '../admissionQueue.js';
import type { KimiWebOperations } from './kimiWebOperations.js';
import type { KimiWebHistory } from './kimiWebHistory.js';
import type { KimiCapabilities } from '../../../shared/runtime/native/kimiWeb/protocol.js';
export type KimiWebDriverOptions = HarnessScope & {
  readonly endpoint: string; readonly getAuthorization: () => string | Promise<string>;
  readonly getAuthority: () => { readonly epoch: string; readonly processGeneration: number };
  readonly store: RuntimeStore; readonly admission?: AdmissionQueue; readonly deadlineMs?: number;
  readonly enabled?: boolean; readonly installed?: boolean;
  readonly authorizeWorkspace?: (input: HarnessScope & { readonly directory: string }) => void | Promise<void>;
} & ({ readonly ownership: 'borrowed'; readonly stopOwned?: never } | { readonly ownership: 'owned'; readonly stopOwned: () => void | Promise<void> });
export interface KimiWebDriver {
  readonly registration: HarnessRegistration;
  readonly operations: KimiWebOperations | undefined;
  close(): Promise<{ readonly closed: true }>;
  reconnect(): Promise<void>; flush(): Promise<void>;
  diagnostics(): { readonly state: string; readonly capabilities: KimiCapabilities; readonly recoveries: number; readonly nativeFrames: number; readonly lifecycleFrames: number; readonly sourceDisconnects: number; readonly heartbeats: { readonly pings: number; readonly pongs: number }; readonly observers: number; readonly selected: number; readonly connected: boolean; readonly nativeConnections: number; readonly eventQueue: number; readonly lastEventError: { readonly code: string; readonly reason: string } | null };
  history: KimiWebHistory['inspect'];
}
export function createKimiWebDriver(options: KimiWebDriverOptions): Promise<KimiWebDriver>;
