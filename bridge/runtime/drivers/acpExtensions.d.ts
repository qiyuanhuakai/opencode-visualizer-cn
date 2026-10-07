import type { SessionRef } from '../../../shared/runtime/identity.js';
import type { OperationScope, Support } from '../../../shared/runtime/harnessContract.js';
import type { AcpObject, AcpRpc } from './acpRpc.js';
import type { AcpCapabilities, AcpQueue } from '../../../shared/runtime/native/acp/capabilities.js';
import type { AcpMutations } from './acpMutations.js';
import type { AcpSessions } from './acpSessions.js';
import type { AcpInteractions } from './acpInteractions.js';
export type AcpNativeInput = AcpObject & { readonly session?: SessionRef };
export function createAcpExtensions(options: {
  readonly capabilities: AcpCapabilities;
  readonly rpc: AcpRpc;
  readonly mutations: AcpMutations;
  readonly sessions: AcpSessions;
  readonly interactions: AcpInteractions;
  readonly queue: AcpQueue;
  readonly send: (input: AcpNativeInput) => Promise<unknown>;
  readonly cwd: string;
  readonly agentId: string;
  readonly active: ReadonlyMap<string, string>;
  readonly createAuthTerminal?: (method: AcpObject) => Promise<{ readonly terminalId: string }>;
}): {
  readonly methods: Readonly<Record<string, (input: AcpNativeInput) => unknown>>;
  readonly declarations: readonly {
    readonly name: string;
    readonly scope: OperationScope;
    readonly support: Support;
  }[];
};
